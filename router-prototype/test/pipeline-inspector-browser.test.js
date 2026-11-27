"use strict";
// Real-browser check of the side panels of the visual editor on /pipelines. Skipped when no Chrome is available.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-inspector-home-"));
process.env.DUCK_HOME = home;
const dashboard = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");
const checks = require("./fixtures/choreo-graph-checks");

const ERRS = "window.__errs = [];"
  + "window.addEventListener('error', (e) => window.__errs.push(String(e.message)));"
  + "window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));"
  + "const __ce = console.error; console.error = (...a) => { window.__errs.push(a.join(' ')); __ce.apply(console, a); };";

test("inspector: pipeline panel, node panel, rename, text round trip, arrow panel, read-only, 375 px", async (t) => {
  const fx = await dashboard.startDashboardFixture();
  let page = null;
  try {
    try { page = await openPage(fx.url + "/pipelines", { initScript: ERRS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    const q = (sel) => JSON.stringify(sel);
    const click = (sel) => page.evaluate(`document.querySelector(${q(sel)}).click()`);
    const key = (k) => `#inspectorHost [data-k=${JSON.stringify(k)}]`;
    // Sets an input and fires the events of a user: input, then change (leaving the input).
    const setValue = (k, value) => page.evaluate(`(() => { const e = document.querySelector(${q(key(k))});
      e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const yaml = async () => { await click("#tabText"); await page.waitFor("document.getElementById('panelText').hidden === false");
      const text = await page.evaluate("document.getElementById('editor').value"); await click("#tabVisual"); return text; };
    const selectNode = (id) => page.evaluate(`document.querySelector('.cvNode[data-node=${id}] rect').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))`);
    await page.setViewport(1280, 1000);

    await page.waitFor("!!document.querySelector('button[data-name=minimal]')");
    const status = await page.evaluate(`fetch('/api/pipelines/minimal/duplicate', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newName: 'inspector-copy' }) }).then((r) => r.status)`);
    assert.equal(status, 201);
    await page.evaluate("location.reload()");
    await page.waitFor("!!document.querySelector('button[data-name=inspector-copy]')");
    await click("button[data-name=inspector-copy]");
    await page.waitFor("document.getElementById('editor') && /name: inspector-copy/.test(document.getElementById('editor').value)");
    await click("#tabVisual");
    await page.waitFor("document.querySelectorAll('.cvNode').length === 4 && !!document.querySelector('#inspectorHost h2')");

    // The pipeline panel: name is text; description and start change.
    assert.equal(await page.evaluate("document.querySelector('#inspectorHost h2').textContent"), "Pipeline");
    assert.equal(await page.evaluate("document.querySelectorAll('#inspectorHost input[type=text], #inspectorHost input:not([type])').length"), 0, "name is not an input");
    assert.equal(await page.evaluate("[...document.querySelectorAll('#inspectorHost [data-k]')].every((e) => document.querySelector('label[for=\"' + e.id + '\"]'))"), true, "each input has a label");
    await setValue("pipe.description", "Edited by the inspector");
    await page.waitFor("!document.getElementById('saveBtn').disabled"); // the text is written and valid
    const start = await page.evaluate(`document.querySelector(${q(key("pipe.start"))}).value`);
    const other = await page.evaluate(`[...document.querySelector(${q(key("pipe.start"))}).options].map((o) => o.value).find((v) => v !== ${JSON.stringify(start)})`);
    await setValue("pipe.start", other);
    await page.waitFor(`document.querySelector('.cvNode[data-node=${other}]').classList.contains('start')`);
    await setValue("pipe.start", start);
    await page.waitFor(`document.querySelector('.cvNode[data-node=${start}]').classList.contains('start')`);

    // The node panel: model, effort, a field, a text prompt.
    await selectNode("impl");
    await page.waitFor("document.querySelector('#inspectorHost h2').textContent === 'Node impl'");
    await setValue("node.model", "__custom");
    await setValue("node.model.text", "my-model");
    await setValue("node.effort", "high");
    await click(key("node.fields.add"));
    await page.waitFor(`!!document.querySelector(${q(key("node.fields.0.description"))})`);
    await setValue("node.fields.0.description", "A test field");
    await setValue("node.fields.0.type", "string");
    await setValue("node.prompt", "text");
    await setValue("node.prompt.text", "Do the work.");
    await page.waitFor("document.querySelector('.cvNode[data-node=impl]').classList.contains('sel')");

    // Rename: the edges follow. A taken id is refused.
    await setValue("node.id", "val");
    await page.waitFor("document.querySelector('#inspectorHost .insErr').textContent.includes('taken')");
    await setValue("node.id", "worker");
    await page.waitFor("!!document.querySelector('.cvNode[data-node=worker]') && !document.querySelector('.cvNode[data-node=impl]')");
    assert.ok(await page.evaluate("document.querySelectorAll('[data-from=worker], [data-to=worker]').length > 0"));

    // The text shows each change and no default values.
    const text = await yaml();
    assert.match(text, /Edited by the inspector/);
    assert.match(text, /worker:/);
    assert.match(text, /model: my-model/);
    assert.match(text, /effort: high/);
    assert.match(text, /A test field/);
    assert.match(text, /prompt: Do the work\./);
    assert.doesNotMatch(text, /maxRounds|timeLimit|failFast|harness:/);
    assert.doesNotMatch(text, /\bimpl\b/);

    // An edit of effort in the text shows in the panel.
    await click("#tabText");
    await page.evaluate("(() => { const ta = document.getElementById('editor'); ta.value = ta.value.replace('effort: high', 'effort: low'); ta.dispatchEvent(new Event('input')); })()");
    await click("#tabVisual");
    await page.waitFor("document.querySelectorAll('.cvNode').length === 4");
    await selectNode("worker");
    await page.waitFor(`document.querySelector(${q(key("node.effort"))}) && document.querySelector(${q(key("node.effort"))}).value === 'low'`);

    // Clear the model: the key leaves the text.
    await setValue("node.model", "");
    await page.waitFor(`!document.querySelector(${q(key("node.model.text"))})`);
    assert.doesNotMatch(await yaml(), /model: my-model/);

    // An arrow: from, to and the interactions.
    await page.evaluate("document.querySelector('[data-arrow]').dispatchEvent(new MouseEvent('click', { bubbles: true }))");
    await page.waitFor("document.querySelector('#inspectorHost h2').textContent === 'Arrow'");
    const dl = await page.evaluate("document.querySelector('#inspectorHost dl').textContent");
    assert.match(dl, /from/);
    assert.match(dl, /interaction/);

    // A built-in pipeline: all inputs are disabled.
    await click("button[data-name=default]");
    await page.waitFor("document.getElementById('tabVisual') && document.getElementById('source')");
    await click("#tabVisual");
    await page.waitFor("document.querySelectorAll('.cvNode').length === 6 && !!document.querySelector('#inspectorHost [data-k]')");
    assert.equal(await page.evaluate("[...document.querySelectorAll('#inspectorHost [data-k]')].every((e) => e.disabled)"), true);

    // 375 px: no horizontal page scroll.
    await page.setViewport(375, 900);
    await selectNode("planner");
    await page.waitFor("document.querySelector('#inspectorHost h2').textContent === 'Node planner'");
    assert.ok(await page.evaluate("document.documentElement.scrollWidth <= 376"), "no horizontal scroll at 375 px");
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await checks.removeManaged(fx.url, ["inspector-copy"]);
    await fx.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
