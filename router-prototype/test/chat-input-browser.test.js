"use strict";
// Real-browser check: the chat textbox never stays disabled, and Send is disabled only while its own
// request runs. Skipped when no Chrome is available.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startDashboardFixture } = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");

// __mode: "pass" (real fetch), "500", "net" (network error), "hang" (wait for __release()).
const STUBS = "window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };"
  + "window.marked = { use() {}, parse: (t) => String(t) };"
  + "window.__errs = []; window.__posts = []; window.__mode = 'pass'; window.__release = null;"
  + "window.addEventListener('error', (e) => window.__errs.push(String(e.message)));"
  + "const __ES = window.EventSource; window.EventSource = function (u) { return (window.__es = new __ES(u)); };"
  + "const __f = window.fetch; window.fetch = (url, opts) => {"
  + " if (!(opts && opts.method === 'POST' && /\\/prompts$/.test(String(url)))) return __f.call(window, url, opts);"
  + " window.__posts.push(opts.body);"
  + " if (window.__mode === 'net') return Promise.reject(new TypeError('Failed to fetch'));"
  + " if (window.__mode === '500') return Promise.resolve(new Response(JSON.stringify({ error: 'Queue is broken' }), { status: 500 }));"
  + " if (window.__mode === 'hang') return new Promise((r) => { window.__release = () => r(new Response('{}', { status: 202 })); });"
  + " return __f.call(window, url, opts); };"
  + "window.__emit = (type, data) => window.__es.dispatchEvent(new MessageEvent('dashboard',"
  + " { data: JSON.stringify({ version: 1, type, lineId: 'browser-line', data }) }));";

const BOX = "document.querySelector('textarea[aria-label=\"Message prompt\"]')";
const SEND = "[...document.querySelectorAll('button')].find((b) => b.textContent === 'Send')";
const BANNER = "document.querySelector('.banner')";

async function withPage(t, fn) {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    await page.setViewport(1100, 900);
    await page.waitFor("/browser[- ]line/i.test(document.body.innerText) && !!window.__es && " + BOX);
    await fn(page, fx);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
}

const state = (page, status, extra = {}) => page.evaluate(
  `window.__emit('state', ${JSON.stringify({ status, transcript: [], planApproved: true, started: true, ...extra })})`);
const enabled = (page) => page.evaluate(`({ box: ${BOX}.disabled, send: ${SEND}.disabled })`);
const type = (page, text) => page.evaluate(`(() => { const b = ${BOX}; b.value = ${JSON.stringify(text)}; b.dispatchEvent(new Event('input')); })()`);
const enter = (page) => page.evaluate(`${BOX}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);

test("textbox and Send stay enabled in every planner status", async (t) => {
  await withPage(t, async (page) => {
    for (const status of ["standby", "idle", "running", "attention", "failed"]) {
      await state(page, status);
      assert.deepEqual(await enabled(page), { box: false, send: false }, status + " via state");
      await page.evaluate(`window.__emit('status', { status: ${JSON.stringify(status)} })`);
      assert.deepEqual(await enabled(page), { box: false, send: false }, status + " via status");
    }
    await state(page, "running");
    assert.equal(await page.evaluate(`${BOX}.placeholder`), "The planner is running. A new prompt waits in the queue.");
    await state(page, "idle");
    assert.equal(await page.evaluate(`${BOX}.placeholder`), "Send a prompt");
    await state(page, "running", { compacting: true, hasSession: true, context: { used: 10, max: 100 } });
    assert.deepEqual(await enabled(page), { box: false, send: false }, "during compaction");
  });
});

test("a 500 answer keeps the text, shows the error and enables Send", async (t) => {
  await withPage(t, async (page) => {
    await page.evaluate("window.__mode = '500'");
    await type(page, "hello");
    await page.evaluate(`${SEND}.click()`);
    await page.waitFor(`!${BANNER}.hidden`);
    assert.match(await page.evaluate(`${BANNER}.textContent`), /Queue is broken/);
    assert.equal(await page.evaluate(`${BOX}.value`), "hello");
    assert.deepEqual(await enabled(page), { box: false, send: false });
  });
});

test("a network error keeps the text and enables Send", async (t) => {
  await withPage(t, async (page) => {
    await page.evaluate("window.__mode = 'net'");
    await type(page, "hello");
    await page.evaluate(`${SEND}.click()`);
    await page.waitFor(`!${BANNER}.hidden`);
    assert.equal(await page.evaluate(`${BOX}.value`), "hello");
    assert.deepEqual(await enabled(page), { box: false, send: false });
  });
});

test("a prompt can be sent while the planner runs", async (t) => {
  await withPage(t, async (page, fx) => {
    await state(page, "running");
    await type(page, "queued prompt");
    await page.evaluate(`${SEND}.click()`);
    await page.waitFor(`${BOX}.value === ''`);
    assert.equal(await page.evaluate("window.__posts.length"), 1);
    assert.deepEqual(JSON.parse(await page.evaluate("window.__posts[0]")), { text: "queued prompt" });
    assert.deepEqual(await enabled(page), { box: false, send: false });
  });
});

test("a second Enter during a request sends no second POST", async (t) => {
  await withPage(t, async (page) => {
    await page.evaluate("window.__mode = 'hang'");
    await type(page, "once");
    await enter(page);
    await page.waitFor("window.__posts.length === 1");
    assert.deepEqual(await enabled(page), { box: false, send: true }, "only Send is disabled");
    await enter(page);
    await page.evaluate(`${SEND}.click()`);
    assert.equal(await page.evaluate("window.__posts.length"), 1);
    await page.evaluate("window.__release()");
    await page.waitFor(`${BOX}.value === '' && !${SEND}.disabled`);
    assert.equal(await page.evaluate("window.__posts.length"), 1);
  });
});
