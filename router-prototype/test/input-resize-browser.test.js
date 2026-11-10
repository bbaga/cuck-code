"use strict";
// Real-browser check: the handle under the chat input sets the textarea height. Skipped when no Chrome is available.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startDashboardFixture } = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");

const STUBS = "window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };"
  + "window.marked = { use() {}, parse: (t) => String(t) };"
  + "window.__errs = []; window.__posts = [];"
  + "window.addEventListener('error', (e) => window.__errs.push(String(e.message)));"
  + "const __f = window.fetch; window.fetch = (url, opts) => {"
  + " if (!(opts && opts.method === 'POST' && /\\/prompts$/.test(String(url)))) return __f.call(window, url, opts);"
  + " window.__posts.push(opts.body); return Promise.resolve(new Response('{}', { status: 202 })); };";

const HANDLE = "document.querySelector('[aria-label=\"Resize message input height\"]')";
const BOX = "document.querySelector('textarea[aria-label=\"Message prompt\"]')";
const SEND = "[...document.querySelectorAll('button')].find((b) => b.textContent === 'Send')";
const KEY = "input-height:browser-line";
const tabBtn = (name) => `[...document.querySelectorAll('.tabBtn')].find((b) => b.textContent === ${JSON.stringify(name)})`;
const height = (page) => page.evaluate(`${BOX}.getBoundingClientRect().height`);
const stored = (page) => page.evaluate(`localStorage.getItem(${JSON.stringify(KEY)})`);
const type = (page, text) => page.evaluate(`(() => { const b = ${BOX}; b.value = ${JSON.stringify(text)};
  b.dispatchEvent(new Event('input', { bubbles: true })); })()`);

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
    await page.waitFor(`!!${HANDLE} && !!${BOX}`);
    await fn(page);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
}

async function reload(page) {
  await page.evaluate("location.reload()");
  await page.waitFor(`!!${HANDLE} && !!${BOX}`);
}

async function drag(page, dy) {
  await page.evaluate(`${HANDLE}.scrollIntoView({ block: 'center' })`);
  const c = await page.evaluate(`(() => { const r = ${HANDLE}.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.mouse("mousePressed", c.x, c.y);
  await page.mouse("mouseMoved", c.x, c.y + dy / 2);
  await page.mouse("mouseMoved", c.x, c.y + dy);
  await page.mouse("mouseReleased", c.x, c.y + dy);
}

const setHeight = async (page, h) => {
  await page.evaluate(`localStorage.setItem(${JSON.stringify(KEY)}, '${h}')`);
  await reload(page);
};

test("arrow keys change the input height by 16 px per press", async (t) => {
  await withPage(t, async (page) => {
    const start = await height(page);
    await page.evaluate(`${HANDLE}.focus()`);
    for (let i = 0; i < 5; i++) await page.press("ArrowDown");
    assert.equal(await height(page), start + 80);
  });
});

test("pointer drag resizes the input and clamps at 36 px and 50% of the window", async (t) => {
  await withPage(t, async (page) => {
    const start = await height(page);
    await drag(page, 100);
    const moved = await height(page);
    assert.ok(Math.abs(moved - (start + 100)) <= 2, `start ${start}, after drag ${moved}`);
    await drag(page, 5000);
    assert.equal(Math.round(await height(page)), await page.evaluate("Math.round(window.innerHeight * 0.5)"));
    await drag(page, -5000);
    assert.equal(Math.round(await height(page)), 36);
  });
});

test("typing keeps the user height", async (t) => {
  await withPage(t, async (page) => {
    await setHeight(page, 150);
    await type(page, "one short line");
    assert.equal(Math.round(await height(page)), 150);
  });
});

test("a send keeps the user height", async (t) => {
  await withPage(t, async (page) => {
    await setHeight(page, 150);
    await type(page, "hello");
    await page.evaluate(`${SEND}.click()`);
    await page.waitFor("window.__posts.length === 1");
    await page.waitFor(`${BOX}.value === ''`);
    assert.equal(Math.round(await height(page)), 150);
  });
});

test("the user height survives a reload", async (t) => {
  await withPage(t, async (page) => {
    await setHeight(page, 150);
    assert.equal(Math.round(await height(page)), 150);
    assert.ok(await stored(page));
  });
});

test("a double-click restores automatic growth", async (t) => {
  await withPage(t, async (page) => {
    const auto = await height(page);
    await setHeight(page, 150);
    await page.evaluate(`${HANDLE}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    assert.equal(await stored(page), null);
    assert.ok(Math.abs(await height(page) - auto) <= 2, "back to one automatic line");
  });
});

test("without a saved height the input grows to 8 lines and scrolls", async (t) => {
  await withPage(t, async (page) => {
    const one = await height(page);
    await type(page, Array.from({ length: 12 }, (_, i) => "line " + i).join("\n"));
    const h = await height(page);
    assert.ok(h > one);
    const lineHeight = await page.evaluate(`parseFloat(getComputedStyle(${BOX}).lineHeight) || 21`);
    assert.ok(Math.abs(h - (lineHeight * 8 + 16)) <= 2, `height ${h}`);
    assert.equal(await page.evaluate(`getComputedStyle(${BOX}).overflowY`), "auto");
  });
});

test("the input handle is hidden off the Line tab", async (t) => {
  await withPage(t, async (page) => {
    await page.evaluate(`${tabBtn("Processes")}.click()`);
    await page.waitFor(`${HANDLE}.hidden || ${HANDLE}.offsetParent === null`);
    await page.evaluate(`${tabBtn("Line")}.click()`);
    await page.waitFor(`!${HANDLE}.hidden && ${HANDLE}.offsetParent !== null`);
  });
});
