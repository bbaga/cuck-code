"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startDashboardFixture } = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");

const STUBS = "window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };"
  + "window.marked = { use() {}, parse: (t) => String(t) };";
const post = (fx, text) => fetch(`${fx.url}/api/lines/${fx.lineId}/prompts`, { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
const INPUT = "document.querySelector('textarea[aria-label=\"Message prompt\"]')";
const SEND = "document.querySelector('textarea[aria-label=\"Message prompt\"]').parentElement.querySelector('button')";
const rows = "[...document.querySelectorAll('.queuePane li')].map((li) => ({ pos: li.querySelector('.qpos').textContent,"
  + " text: li.querySelector('.qtext').textContent, dis: li.querySelector('button').disabled,"
  + " err: !!li.querySelector('[role=alert]'), label: li.querySelector('button').getAttribute('aria-label') }))";

// Opens the real dashboard with a run kept active by the fake planner child.
async function withPage(t, body, opts = {}) {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    try { page = await openPage(fx.url, { initScript: STUBS + (opts.init || "") }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    await page.waitFor("/browser[- ]line/i.test(document.body.innerText)");
    await body(fx, page);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
}
async function twoQueued(fx, page) {
  assert.equal((await post(fx, "run")).status, 202);
  assert.equal((await post(fx, "first <b>waiting</b>")).status, 202);
  assert.equal((await post(fx, "second waiting")).status, 202);
  await page.waitFor(`${rows}.length === 2`);
}

test("a: two prompts during a run show ordered rows and the input stays enabled", async (t) => {
  await withPage(t, async (fx, page) => {
    await twoQueued(fx, page);
    const r = await page.evaluate(`({ rows: ${rows}, off: ${INPUT}.disabled,
      region: document.querySelector('.queuePane').getAttribute('aria-label') })`);
    assert.deepEqual(r.rows.map((x) => x.pos), ["1.", "2."]);
    assert.equal(r.rows[0].text, "first <b>waiting</b>");
    assert.match(r.rows[0].label, /^Cancel queued prompt 1: first/);
    assert.equal(r.off, false);
    assert.equal(r.region, "Waiting prompts");
  });
});

test("b: cancelling the first row keeps the second and leaves other controls enabled", async (t) => {
  await withPage(t, async (fx, page) => {
    await twoQueued(fx, page);
    await page.evaluate(`window.__d = null; const f = window.fetch; window.fetch = (u, o) => (o && o.method === 'DELETE')
      ? new Promise((r) => { window.__d = () => f(u, o).then(r); }) : f(u, o); 0`);
    await page.evaluate("document.querySelector('.queuePane li button').click()");
    const mid = await page.evaluate(`({ rows: ${rows}, send: ${SEND}.disabled })`);
    assert.deepEqual(mid.rows.map((x) => x.dis), [true, false]);
    assert.equal(mid.send, false);
    await page.evaluate("window.__d()");
    await page.waitFor(`${rows}.length === 1`);
    assert.equal((await page.evaluate(rows))[0].text, "second waiting");
  });
});

test("c: cancel of a started id keeps the row and shows a local error", async (t) => {
  await withPage(t, async (fx, page) => {
    await twoQueued(fx, page);
    await page.evaluate(`const f = window.fetch; window.fetch = (u, o) => (o && o.method === 'DELETE')
      ? f(u.replace(/prompts\\/.*/, 'prompts/unknown-id'), o) : f(u, o); 0`);
    await page.evaluate("document.querySelector('.queuePane li button').click()");
    await page.waitFor(`${rows}[0].err`);
    const r = await page.evaluate(rows);
    assert.equal(r.length, 2);
    assert.equal(r[0].dis, false);
  });
});

test("d: typing during an in-flight submission keeps the new text", async (t) => {
  await withPage(t, async (fx, page) => {
    await page.evaluate(`const f = window.fetch; window.fetch = (u, o) => (o && o.method === 'POST' && /prompts$/.test(u))
      ? new Promise((r) => { window.__p = () => f(u, o).then(r); }) : f(u, o); 0`);
    await page.evaluate(`const i = ${INPUT}; i.value = 'one';
      i.dispatchEvent(new Event('input')); ${SEND}.click();
      i.value = 'one two'; i.dispatchEvent(new Event('input')); 0`);
    await page.evaluate("window.__p()");
    await page.waitFor(`${SEND}.disabled === false`);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await page.evaluate(`${INPUT}.value`), "one two");
  });
});

test("e: a failed submission keeps the draft and shows the error", async (t) => {
  await withPage(t, async (fx, page) => {
    await page.evaluate(`const f = window.fetch; window.fetch = (u, o) => (o && o.method === 'POST' && /prompts$/.test(u))
      ? Promise.resolve(new Response('{}', { status: 500 })) : f(u, o); 0`);
    await page.evaluate(`const i = ${INPUT}; i.value = 'keep me';
      i.dispatchEvent(new Event('input')); ${SEND}.click(); 0`);
    await page.waitFor("!document.querySelector('.composerError').hidden");
    assert.equal(await page.evaluate(`${INPUT}.value`), "keep me");
    assert.equal(await page.evaluate("document.querySelector('.composerError').getAttribute('role')"), "alert");
  });
});

// f and g call the page handlers directly: the dashboard has no hook to send a chosen revision.
const SYNTH = (lineId, epoch, rev, texts) => `(() => { const ev = new MessageEvent('dashboard', { data: JSON.stringify({
  version: 1, type: 'state', lineId: ${JSON.stringify(lineId)}, data: { stateEpoch: ${JSON.stringify(epoch)},
  stateRevision: ${rev}, queuedUserPrompts: ${JSON.stringify(texts.map((text, i) => ({ id: "s" + i, text, position: i + 1 })))} } }) });
  window.__streams.forEach((s) => s.dispatchEvent(ev)); })()`;
const TRACK = "window.__streams = []; const ES = window.EventSource; window.EventSource = function (u) {"
  + " const s = new ES(u); window.__streams.push(s); return s; };";

test("f: lower revision is ignored and a new epoch is accepted (synthetic state events)", async (t) => {
  await withPage(t, async (fx, page) => {
    await page.evaluate(SYNTH(fx.lineId, "e1", 1000, ["newer"]));
    await page.waitFor(`${rows}.length === 1 && ${rows}[0].text === 'newer'`);
    await page.evaluate(SYNTH(fx.lineId, "e1", 999, ["older", "older2"]));
    assert.equal((await page.evaluate(rows)).length, 1);
    await page.evaluate(SYNTH(fx.lineId, "e2", 1, ["restart"]));
    await page.waitFor(`${rows}[0].text === 'restart'`);
  }, { init: TRACK });
});

const DISPATCH = (data) => `window.__streams.forEach((s) => s.dispatchEvent(new MessageEvent('dashboard',
  { data: JSON.stringify(Object.assign({ version: 1 }, ${JSON.stringify(data)})) })))`;

test("g: a late DELETE response for a replaced line card changes nothing (in-page script)", async (t) => {
  await withPage(t, async (fx, page) => {
    await twoQueued(fx, page);
    await page.evaluate(`const f = window.fetch; window.fetch = (u, o) => (o && o.method === 'DELETE')
      ? new Promise((r) => { window.__d = () => r(new Response(JSON.stringify({ queuedUserPrompts: [],
        stateEpoch: 'x', stateRevision: 99999 }), { status: 200 })); }) : f(u, o); 0`);
    await page.evaluate("document.querySelector('.queuePane li button').click()");
    const line = { id: fx.lineId, name: "Browser line", status: "idle", started: true };
    await page.evaluate(DISPATCH({ type: "snapshot_begin", data: { lines: [] } }));
    await page.evaluate(DISPATCH({ type: "snapshot_begin", data: { lines: [line] } }));
    await page.evaluate(SYNTH(fx.lineId, "e1", 5000, ["a", "b"]));
    await page.waitFor(`${rows}.length === 2 && ${rows}[0].text === 'a'`);
    await page.evaluate("window.__d()");
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual((await page.evaluate(rows)).map((x) => x.text), ["a", "b"]);
  }, { init: TRACK });
});

test("h: after a stream reconnect the queue shows the server state", async (t) => {
  await withPage(t, async (fx, page) => {
    await twoQueued(fx, page);
    await page.evaluate("window.__streams.forEach((s) => s.close()); 0");
    await post(fx, "third");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await page.evaluate(rows)).length, 2);
    // A failed cancel calls refreshStream, which opens a new stream and gets fresh state.
    await page.evaluate(`const f = window.fetch; window.fetch = (u, o) => (o && o.method === 'DELETE')
      ? Promise.resolve(new Response('{}', { status: 409 })) : f(u, o); 0`);
    await page.evaluate("document.querySelector('.queuePane li button').click()");
    await page.waitFor(`${rows}.length === 3`);
    assert.equal((await page.evaluate(rows))[2].text, "third");
  }, { init: TRACK });
});
