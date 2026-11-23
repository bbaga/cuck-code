"use strict";
// Real-browser check of the safe-for-work toggle on the dashboard: the brand
// text, the title, the icon link and the logo react to the checkbox, and the
// setting persists through localStorage. Skipped when no Chrome is available.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startDashboardFixture } = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");

const STUBS = "window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };"
  + "window.marked = { use() {}, parse: (t) => String(t) };"
  + "window.__errs = [];"
  + "window.addEventListener('error', (e) => window.__errs.push(String(e.message)));"
  + "const __ES = window.EventSource; window.EventSource = function (u) { return (window.__es = new __ES(u)); };";

const STATE = `({
  checked: document.getElementById('sfwToggle').checked,
  brand: document.querySelector('h1 [data-brand]').textContent,
  title: document.title,
  icon: document.querySelector('link[rel="icon"]').getAttribute('href'),
  logo: document.querySelector('img[data-brand-logo]').getAttribute('src'),
  stored: window.localStorage.getItem('cuck.sfw'),
})`;

async function withPage(t, fn, initScript = "") {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    try { page = await openPage(fx.url, { initScript: initScript + STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    await page.setViewport(1100, 900);
    await page.waitFor("!!document.getElementById('sfwToggle') && !!window.__es");
    await fn(page, fx);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
}

const noErrors = (page) => page.evaluate("window.__errs").then((errs) => assert.deepEqual(errs, []));

test("default state keeps the cuck-code brand", async (t) => {
  await withPage(t, async (page) => {
    assert.deepEqual(await page.evaluate(STATE), {
      checked: false, brand: "cuck-code", title: "cuck-code router",
      icon: "/favicon.svg", logo: "/favicon.svg", stored: null,
    });
    await noErrors(page);
  });
});

test("a click switches the brand to duck-code and stores the setting", async (t) => {
  await withPage(t, async (page) => {
    await page.evaluate("document.getElementById('sfwToggle').click()");
    const on = await page.evaluate(STATE);
    assert.equal(on.checked, true);
    assert.equal(on.brand, "duck-code");
    assert.equal(on.title, "duck-code router");
    assert.ok(on.icon.endsWith("/favicon-duck.svg"), "icon must be the duck svg");
    assert.ok(on.logo.endsWith("/favicon-duck.svg"), "logo must be the duck svg");
    assert.equal(on.stored, "1");
    await noErrors(page);

    await page.evaluate("document.getElementById('sfwToggle').click()");
    const off = await page.evaluate(STATE);
    assert.equal(off.checked, false);
    assert.equal(off.brand, "cuck-code");
    assert.equal(off.title, "cuck-code router");
    assert.ok(off.icon.endsWith("/favicon.svg"), "icon must be the default svg");
    assert.ok(off.logo.endsWith("/favicon.svg"), "logo must be the default svg");
    assert.equal(off.stored, null);
    await noErrors(page);
  });
});

test("a stored setting applies on load", async (t) => {
  await withPage(t, async (page) => {
    const state = await page.evaluate(STATE);
    assert.equal(state.checked, true);
    assert.equal(state.brand, "duck-code");
    assert.equal(state.title, "duck-code router");
    assert.ok(state.icon.endsWith("/favicon-duck.svg"), "icon must be the duck svg");
    assert.ok(state.logo.endsWith("/favicon-duck.svg"), "logo must be the duck svg");
    assert.equal(state.stored, "1");
    await noErrors(page);
  }, "localStorage.setItem('cuck.sfw', '1');");
});