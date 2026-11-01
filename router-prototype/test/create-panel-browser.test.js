"use strict";
// Real-browser check of the create panel (D4): pipeline picker, one settings row per node.
// Skipped when no Chrome is available. Set CREATE_PANEL_SHOTS=<dir> to save screenshots.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startDashboardFixture } = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");

const STUBS = "window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };"
  + "window.marked = { use() {}, parse: (t) => String(t) };"
  + "window.__errs = [];"
  + "window.addEventListener('error', (e) => window.__errs.push(String(e.message)));"
  + "window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));"
  + "const __ce = console.error; console.error = (...a) => { window.__errs.push(a.join(' ')); __ce.apply(console, a); };";

const ROWS = "[...document.querySelectorAll('#createPanel .phaseRow')]";
const ids = `${ROWS}.map((r) => r.querySelector('.phaseName').textContent)`;

test("create panel: picker lists pipelines, rows follow the picked pipeline", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    const shots = process.env.CREATE_PANEL_SHOTS;
    if (shots) fs.mkdirSync(shots, { recursive: true });
    const shot = async (name) => { if (shots) await page.screenshot(path.join(shots, name)); };
    await page.setViewport(1100, 1100);
    await page.waitFor("/browser[- ]line/i.test(document.body.innerText)");
    await page.evaluate("document.getElementById('create').click()");
    await page.waitFor("document.querySelectorAll('#cp-pipeline option').length >= 2");
    const options = await page.evaluate("[...document.querySelectorAll('#cp-pipeline option')].map((o) => o.value + '|' + o.textContent)");
    assert.equal(options[0].split('|')[0], 'default');
    assert.match(options[0], /default - .* \(built-in\)/);
    assert.ok(options.some((o) => o.startsWith('minimal|')));
    assert.equal(await page.evaluate("document.getElementById('cp-pipeline').value"), 'default');

    await page.waitFor(`${ROWS}.length === 6`);
    const defaultRows = await page.evaluate(ids);
    assert.equal(defaultRows[0], 'planner (planner)');
    assert.equal(defaultRows[1], 'backend-impl (backend-implementor)');
    // max-context control: resumed nodes have it, fresh-session nodes do not
    const ctx = await page.evaluate(`${ROWS}.map((r) => !!r.querySelector('input'))`);
    assert.deepEqual(ctx, [true, true, true, false, false, false]);
    await shot('create-default-1100.png');

    await page.evaluate(`(() => { const s = document.getElementById('cp-pipeline'); s.value = 'minimal'; s.dispatchEvent(new Event('change')); })()`);
    await page.waitFor(`${ROWS}.length === 4`);
    assert.deepEqual(await page.evaluate(ids), ['planner (planner)', 'impl (implementor)', 'val (validator)', 'integration (integration-validator)']);
    assert.deepEqual(await page.evaluate(`${ROWS}.map((r) => !!r.querySelector('input'))`), [true, true, false, false]);
    await shot('create-minimal-1100.png');

    // typed values survive for node ids that stay
    await page.evaluate(`(() => { const i = document.getElementById('cp-maxctx-planner'); i.value = '200K'; })()`);
    await page.evaluate(`(() => { const s = document.getElementById('cp-pipeline'); s.value = 'default'; s.dispatchEvent(new Event('change')); })()`);
    await page.waitFor(`${ROWS}.length === 6`);
    assert.equal(await page.evaluate("document.getElementById('cp-maxctx-planner').value"), '200K');
    assert.equal(await page.evaluate("document.getElementById('cp-maxctx-frontend-val')"), null);

    await page.setViewport(375, 900);
    await shot('create-default-375.png');
    assert.ok(await page.evaluate("document.documentElement.scrollWidth <= 375 + 1"), 'no horizontal scroll at 375 px');
    await page.setViewport(1100, 1100);

    // Save as pipeline: inline name field, then the new pipeline is picked
    await page.evaluate("document.getElementById('cp-save-as').click()");
    await page.evaluate(`(() => { const i = document.getElementById('cp-save-name'); i.value = 'my-tuned'; })()`);
    await page.evaluate("document.getElementById('cp-save-ok').click()");
    await page.waitFor("document.getElementById('cp-pipeline').value === 'my-tuned'");
    await page.waitFor(`${ROWS}.length === 6`);
    const saved = await (await fetch(`${fx.url}/api/pipelines/my-tuned`)).json();
    assert.match(saved.text, /maxContext: 200000/);
    assert.match(await page.evaluate("document.querySelector('#cp-pipeline option:checked').textContent"), /\(managed\)/);

    const errs = await page.evaluate("window.__errs");
    assert.deepEqual(errs, []);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
});
