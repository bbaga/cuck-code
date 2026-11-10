"use strict";
// Real-browser check: the plan handle resizes the plan box before approval and the open Plan
// details after approval. Skipped when no Chrome is available.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startDashboardFixture } = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");

const PLAN = Array.from({ length: 80 }, (_, i) => "Plan line " + i).join("<br>");
const STUBS = "window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };"
  + "window.marked = { use() {}, parse: (t) => String(t) };"
  + "window.__errs = []; window.__approved = false;"
  + "window.addEventListener('error', (e) => window.__errs.push(String(e.message)));"
  + "const __f = window.fetch; window.fetch = (url, opts) => /\\/plan$/.test(String(url))"
  + " ? Promise.resolve(new Response(JSON.stringify({ exists: true, approved: window.__approved,"
  + ` content: ${JSON.stringify(PLAN)} }))) : __f.call(window, url, opts);`;

const HANDLE = "document.querySelector('[aria-label=\"Resize plan height\"]')";
const PLAN_BOX = "document.querySelector('.plan')";
const BODY = "document.querySelector('.planBody')";
const BOX = "document.querySelector('textarea[aria-label=\"Message prompt\"]')";
const KEY = "plan-height:browser-line";
const height = (page, el) => page.evaluate(`${el}.getBoundingClientRect().height`);

test("the plan handle resizes, persists, resets and keeps the chat reachable", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    await page.setViewport(1100, 900);
    await page.waitFor(`!!${HANDLE} && ${BODY}.textContent.includes('Plan line 79') && !${PLAN_BOX}.hidden`);
    const start = await height(page, PLAN_BOX);
    assert.ok(start <= 260);

    await page.evaluate(`${HANDLE}.focus()`);
    for (let i = 0; i < 10; i++) await page.press("ArrowDown");
    assert.equal(await height(page, PLAN_BOX), start + 160);

    await page.evaluate("location.reload()");
    await page.waitFor(`!!${HANDLE} && !!${PLAN_BOX} && ${PLAN_BOX}.getBoundingClientRect().height > 260`);
    assert.equal(await height(page, PLAN_BOX), start + 160);
    assert.ok(await page.evaluate(`localStorage.getItem(${JSON.stringify(KEY)})`));

    await page.evaluate(`${HANDLE}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    assert.ok(await height(page, PLAN_BOX) <= 260);
    assert.equal(await page.evaluate(`localStorage.getItem(${JSON.stringify(KEY)})`), null);

    // Maximum height: the chat box must stay reachable inside the card.
    await page.evaluate(`${HANDLE}.focus()`);
    await page.press("ArrowUp");
    await page.evaluate("localStorage.setItem('" + KEY + "', '99999')");
    await page.evaluate("location.reload()");
    await page.waitFor(`!!${HANDLE} && ${PLAN_BOX}.getBoundingClientRect().height > 700`);
    await page.evaluate(`${BOX}.scrollIntoView()`);
    const box = await page.evaluate(`(() => { const r = ${BOX}.getBoundingClientRect();
      return r.height > 0 && r.bottom > 0 && r.top < innerHeight; })()`);
    assert.ok(box, "chat input is reachable");

    // After approval the same handle sits in the Plan details and resizes the plan body.
    await page.evaluate("window.__approved = true");
    await page.waitFor(`${BODY}.parentNode.classList.contains('planDetails')`, { timeoutMs: 15000 });
    assert.equal(await page.evaluate(`${HANDLE}.parentNode === ${BODY}.parentNode`), true);
    await page.evaluate("document.querySelector('.planDetails').open = true");
    const before = await height(page, BODY);
    await page.evaluate(`${HANDLE}.focus()`);
    await page.press("ArrowUp");
    assert.ok(await height(page, BODY) < before);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
});
