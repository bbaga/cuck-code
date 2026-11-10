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
const PLAN_DETAILS = "document.querySelector('.planDetails')";
const GRAPH = "document.querySelector('.graph')";
const CHAT = "document.querySelector('.transcriptWrap')";
const SEND = "[...document.querySelectorAll('button')].find((b) => b.textContent === 'Send')";
const tabBtn = (name) => `[...document.querySelectorAll('.tabBtn')].find((b) => b.textContent === ${JSON.stringify(name)})`;
const height = (page, el) => page.evaluate(`${el}.getBoundingClientRect().height`);


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
    await page.waitFor(`!!${HANDLE} && ${BODY}.textContent.includes('Plan line 79') && !${PLAN_BOX}.hidden`);
    await fn(page);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
}

async function reload(page, ready) {
  await page.evaluate("location.reload()");
  await page.waitFor(ready);
}

// Drag a handle by dy px with real mouse input from the centre of the handle.
async function drag(page, handle, dy) {
  const c = await page.evaluate(`(() => { const r = ${handle}.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.mouse("mousePressed", c.x, c.y);
  await page.mouse("mouseMoved", c.x, c.y + dy / 2);
  await page.mouse("mouseMoved", c.x, c.y + dy);
  await page.mouse("mouseReleased", c.x, c.y + dy);
}

const inView = (page, el, box) => page.evaluate(`(() => { const e = ${el}; e.scrollIntoView();
  const r = e.getBoundingClientRect(), c = ${box}.getBoundingClientRect();
  return r.height > 0 && r.top >= c.top - 1 && r.bottom <= c.bottom + 1; })()`);
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

test("pointer drag resizes the plan and clamps at 80 px and 85% of the window", async (t) => {
  await withPage(t, async (page) => {
    const start = await height(page, PLAN_BOX);
    await drag(page, HANDLE, 120);
    const moved = await height(page, PLAN_BOX);
    assert.ok(Math.abs(moved - (start + 120)) <= 2, `start ${start}, after drag ${moved}`);
    await drag(page, HANDLE, 5000);
    const max = await page.evaluate("Math.round(window.innerHeight * 0.85)");
    assert.equal(Math.round(await height(page, PLAN_BOX)), max);
    await page.evaluate(`${HANDLE}.scrollIntoView()`);
    await drag(page, HANDLE, -5000);
    assert.equal(Math.round(await height(page, PLAN_BOX)), 80);
  });
});

test("at maximum plan height the prompt box and Send stay reachable in the card", async (t) => {
  await withPage(t, async (page) => {
    await page.evaluate(`localStorage.setItem('${KEY}', '99999')`);
    await reload(page, `${PLAN_BOX}.getBoundingClientRect().height > 700`);
    const card = "document.querySelector('.card')";
    assert.ok(await inView(page, BOX, card), "textarea is inside the card view");
    assert.ok(await inView(page, SEND, card), "Send is inside the card view");
  });
});

test("the plan handle is hidden on other tabs and returns on the Line tab", async (t) => {
  await withPage(t, async (page) => {
    for (const name of ["Processes", "Evidence", "Pipeline"]) {
      await page.evaluate(`${tabBtn(name)}.click()`);
      assert.equal(await page.evaluate(`${HANDLE}.hidden || ${HANDLE}.offsetParent === null`), true, name);
    }
    await page.evaluate(`${tabBtn("Line")}.click()`);
    assert.equal(await page.evaluate(`!${HANDLE}.hidden && ${HANDLE}.offsetParent !== null`), true);
  });
});

test("the pipeline and chat handles still resize and persist", async (t) => {
  await withPage(t, async (page) => {
    for (const [label, el, key] of [["Resize pipeline schematic height", GRAPH, "graph-height:browser-line"],
      ["Resize chat height", CHAT, "chat-height:browser-line"]]) {
      const handle = `document.querySelector('[aria-label="${label}"]')`;
      // Seed a size above both minimums so every step moves the section.
      await page.evaluate(`localStorage.setItem('${key}', '300')`);
      await reload(page, `!!${handle} && ${PLAN_BOX}.getBoundingClientRect().height > 0`);
      await page.evaluate(`${handle}.focus()`);
      const start = await height(page, el);
      for (let i = 0; i < 5; i++) await page.press("ArrowDown");
      assert.equal(await height(page, el), start + 80, label);
      await reload(page, `!!${handle} && ${PLAN_BOX}.getBoundingClientRect().height > 0`);
      assert.equal(await height(page, el), start + 80, label + " after reload");
    }
  });
});

test("the saved plan height applies to the open Plan details after approval", async (t) => {
  await withPage(t, async (page) => {
    await page.evaluate(`${HANDLE}.focus()`);
    for (let i = 0; i < 5; i++) await page.press("ArrowDown");
    const saved = await page.evaluate(`localStorage.getItem('${KEY}')`);
    assert.ok(saved);
    await page.evaluate("window.__approved = true");
    await page.waitFor(`${BODY}.parentNode.classList.contains('planDetails')`, { timeoutMs: 15000 });
    await page.evaluate(`${PLAN_DETAILS}.open = true`);
    assert.equal(await page.evaluate(`parseFloat(getComputedStyle(${BODY}).maxHeight)`), Number(saved));
    assert.equal(await page.evaluate(`localStorage.getItem('${KEY}')`), saved);
  });
});
