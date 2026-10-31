"use strict";
// Real dashboard in real Chrome. Escape keys use Input.dispatchKeyEvent through page.press.
// Composition cases (h) use dispatchEvent because the driver cannot start an IME session.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startDashboardFixture } = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");

const STUBS = "window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };"
  + "window.marked = { use() {}, parse: (t) => String(t) };";
// Logs every interrupt call and every keydown after the page handlers ran. __stub sets a fake status.
const SPY = `window.__calls = []; window.__keys = []; window.__stub = null;
  const f = window.fetch; window.fetch = (u, o) => {
    if (/\\/interrupt$/.test(u)) { window.__calls.push(JSON.parse(o.body));
      if (window.__stub) return Promise.resolve(new Response('{}', { status: window.__stub })); }
    return f(u, o); };
  window.addEventListener('keydown', (e) => window.__keys.push({ key: e.key, repeat: e.repeat, dp: e.defaultPrevented }));`;
const INPUT = "document.querySelector('textarea[aria-label=\"Message prompt\"]')";
const SEND = `${INPUT}.parentElement.querySelector('button')`;
const STATUS = "document.querySelector('.stopStatus')";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (fx, text) => fetch(`${fx.url}/api/lines/${fx.lineId}/prompts`, { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
const SYNTH = (lineId, rev, data) => `(() => { const ev = new MessageEvent('dashboard', { data: JSON.stringify({
  version: 1, type: 'state', lineId: ${JSON.stringify(lineId)}, data: { stateEpoch: 'x', stateRevision: ${rev}, ...${JSON.stringify(data)} } }) });
  window.__streams.forEach((s) => s.dispatchEvent(ev)); })()`;
const TRACK = "window.__streams = []; const ES = window.EventSource; window.EventSource = function (u) {"
  + " const s = new ES(u); window.__streams.push(s); return s; };";

async function withPage(t, body, { running = true } = {}) {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    try { page = await openPage(fx.url, { initScript: STUBS + SPY + TRACK }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    await page.waitFor("/browser[- ]line/i.test(document.body.innerText)");
    if (running) {
      assert.equal((await post(fx, "run")).status, 202);
      await page.waitFor("[...document.querySelectorAll('.dot')].some((d) => d.getAttribute('aria-label') === 'Running' || d.classList.contains('running'))").catch(() => {});
      await sleep(600);
    }
    await page.evaluate(`${INPUT}.focus(); 0`);
    await body(fx, page);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
}
const calls = (page) => page.evaluate("window.__calls");
const keys = (page) => page.evaluate("window.__keys");

test("a: two Escapes in 300 ms send one request for the displayed run", async (t) => {
  await withPage(t, async (fx, page) => {
    await page.press("Escape"); await sleep(300); await page.press("Escape");
    await page.waitFor("window.__calls.length === 1");
    await sleep(300);
    const c = await calls(page);
    assert.equal(c.length, 1);
    assert.equal(c[0].runId, fx.controls.state().activePlannerRunId);
    assert.deepEqual((await keys(page)).map((k) => k.dp), [false, true]);
  });
});

test("b: two Escapes 700 ms apart send no request", async (t) => {
  await withPage(t, async (fx, page) => {
    await page.press("Escape"); await sleep(700); await page.press("Escape");
    await sleep(300);
    assert.equal((await calls(page)).length, 0);
  });
});

test("c: a held Escape sends no request", async (t) => {
  await withPage(t, async (fx, page) => {
    await page.press("Escape");
    for (let i = 0; i < 8; i++) await page.press("Escape", { repeat: true });
    await sleep(300);
    assert.equal((await calls(page)).length, 0);
    assert.equal((await keys(page)).filter((k) => k.repeat).length, 8);
  });
});

test("d: a 409 shows an alert, sends no second request, keeps controls enabled", async (t) => {
  await withPage(t, async (fx, page) => {
    await post(fx, "waiting one");
    await page.waitFor("document.querySelectorAll('.queuePane li button').length === 1");
    await page.evaluate("window.__stub = 409; 0");
    await page.press("Escape"); await page.press("Escape");
    await page.waitFor(`${STATUS} && !${STATUS}.hidden && ${STATUS}.getAttribute('role') === 'alert'`);
    await sleep(300);
    const r = await page.evaluate(`({ n: window.__calls.length, text: ${STATUS}.textContent,
      input: ${INPUT}.disabled, send: ${SEND}.disabled,
      cancel: [...document.querySelectorAll('.queuePane li button')].map((b) => b.disabled) })`);
    assert.equal(r.n, 1);
    assert.match(r.text, /Press Escape twice again/);
    assert.equal(r.input, false); assert.equal(r.send, false);
    assert.deepEqual(r.cancel, [false]);
    await page.evaluate(`${STATUS}.querySelector('button').click(); 0`);
    assert.equal(await page.evaluate(`${STATUS}.hidden`), true);
  });
});

test("e: a 202 shows pending status until a state shows the run ended", async (t) => {
  await withPage(t, async (fx, page) => {
    await page.press("Escape"); await page.press("Escape");
    await page.waitFor(`!${STATUS}.hidden && ${STATUS}.getAttribute('role') === 'status'`);
    assert.match(await page.evaluate(`${STATUS}.textContent`), /Stopping the planner run/);
    await sleep(500);
    assert.equal(await page.evaluate(`${STATUS}.hidden`), false);
    fx.controls.closeActive(0);
    await page.waitFor(`${STATUS}.hidden`);
  });
});

test("f: Escape with the create panel open sends no request (evidence view is not reachable here)", async (t) => {
  await withPage(t, async (fx, page) => {
    await page.evaluate("document.getElementById('create').click(); 0");
    await page.press("Escape"); await page.press("Escape");
    await sleep(300);
    assert.equal((await calls(page)).length, 0);
  });
});

test("g: Escape while idle sends no request", async (t) => {
  await withPage(t, async (fx, page) => {
    await page.press("Escape"); await page.press("Escape");
    await sleep(300);
    assert.equal((await calls(page)).length, 0);
  }, { running: false });
});

test("h: a composition in progress sends no request (dispatchEvent)", async (t) => {
  await withPage(t, async (fx, page) => {
    await page.press("Escape");
    await page.evaluate(`${INPUT}.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); 0`);
    await page.press("Escape");
    await page.evaluate(`${INPUT}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, keyCode: 229, bubbles: true })); 0`);
    await sleep(300);
    assert.equal((await calls(page)).length, 0);
  });
});

test("i: a line switch between presses sends no request", async (t) => {
  await withPage(t, async (fx, page) => {
    await page.press("Escape");
    await page.evaluate("document.querySelector('#linelist > *').click(); 0");
    await page.press("Escape");
    await sleep(300);
    assert.equal((await calls(page)).length, 0);
  });
});

test("j: while the stop is pending the user can type, send and cancel", async (t) => {
  await withPage(t, async (fx, page) => {
    await post(fx, "waiting one");
    await page.waitFor("document.querySelectorAll('.queuePane li button').length === 1");
    await page.press("Escape"); await page.press("Escape");
    await page.waitFor(`!${STATUS}.hidden`);
    await page.evaluate(`const i = ${INPUT}; i.value = 'draft'; i.dispatchEvent(new Event('input')); 0`);
    const r = await page.evaluate(`({ input: ${INPUT}.disabled, send: ${SEND}.disabled,
      cancel: document.querySelector('.queuePane li button').disabled, value: ${INPUT}.value })`);
    assert.deepEqual(r, { input: false, send: false, cancel: false, value: "draft" });
    await page.evaluate("document.querySelector('.queuePane li button').click(); 0");
    await page.waitFor("document.querySelectorAll('.queuePane li').length === 0");
    await page.evaluate(`${SEND}.click(); 0`);
    await page.waitFor(`${INPUT}.value === ''`);
  });
});
