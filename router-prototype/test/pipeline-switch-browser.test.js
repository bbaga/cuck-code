"use strict";
// Real-browser check of "Change the pipeline" in the line Pipeline tab. Skipped when no Chrome is available.
// Screenshots go to PIPELINE_SWITCH_SHOTS=<dir> when set.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startDashboardFixture } = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");
const { loadBuiltinPipeline } = require("../line-graph");

const ROOT = path.join(__dirname, "..");
const STUBS = "window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };"
  + "window.marked = { use() {}, parse: (t) => String(t) };"
  + "window.__errs = [];"
  + "window.addEventListener('error', (e) => window.__errs.push(String(e.message)));"
  + "window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));"
  + "const __ce = console.error; console.error = (...a) => { window.__errs.push(a.join(' ')); __ce.apply(console, a); };";
const PANE = "document.querySelector('.pipePane')";
const SW = `${PANE}.querySelector('.pipeSwitch')`;

// A line with the default graph and workers on its nodes.
function seedWorkers(line, { running } = {}) {
  line.graph = loadBuiltinPipeline("default", fs, ROOT);
  line.nodeSettings = { "backend-impl": { model: "sonnet" }, "frontend-impl": { model: "haiku" } };
  const impl = (id, name, node, persona) => ({ id, name, node, persona, role: "implementor", status: "completed",
    repo: "api", branch: "b/" + name, runGeneration: 1, transcript: [], children: [] });
  const val = (id, name, node, persona, validates) => ({ id, name, node, persona, role: "validator", kind: "standard",
    validates, status: "completed", transcript: [] });
  for (const w of [impl("i1", "api", "backend-impl", "backend"), impl("i2", "ui", "frontend-impl", "frontend"),
    val("v1", "api-val", "backend-val", "backend", "i1"), val("v2", "ui-val", "frontend-val", "frontend", "i2"),
    { id: "g1", name: "int", node: "integration", role: "validator", kind: "integration", status: "completed", transcript: [] }]) {
    line.workers.set(w.id, w);
  }
  if (running) line.workers.get("i1").status = "running";
}

async function open(fx, t) {
  let page;
  try { page = await openPage(fx.url, { initScript: STUBS }); }
  catch (e) {
    if (e.code === "BROWSER_UNAVAILABLE") { t.skip("Chrome is missing: " + e.message); return null; }
    throw e;
  }
  await page.setViewport(1100, 1100);
  await page.waitFor("/browser[- ]line/i.test(document.body.innerText)");
  await page.evaluate("[...document.querySelectorAll('button.tabBtn')].find((b) => b.textContent === 'Pipeline').click()");
  await page.waitFor(`${PANE} && !${PANE}.hidden && ${SW} && ${SW}.querySelectorAll('option').length > 1`);
  return page;
}
const click = (page, label) => page.evaluate(`[...${SW}.querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);
const applyDisabled = (page) => page.evaluate(`[...${SW}.querySelectorAll('button')].find((b) => b.textContent === 'Apply').disabled`);
const pick = (page, sel, value) => page.evaluate(`(() => { const s = ${sel}; s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); })()`);

test("pipeline switch: check, map, apply, 375 px", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    seedWorkers(require("../server").lines.get(fx.lineId));
    page = await open(fx, t);
    if (!page) return;
    const shots = process.env.PIPELINE_SWITCH_SHOTS;
    if (shots) fs.mkdirSync(shots, { recursive: true });
    const shot = async (name) => { if (shots) await page.screenshot(path.join(shots, name)); };

    // the section: picker with the current pipeline marked and preselected
    assert.match(await page.evaluate(`${PANE}.innerText`), /Choose another pipeline to change the graph\./);
    assert.doesNotMatch(await page.evaluate(`${PANE}.innerText`), /does not change after creation/);
    const pickSel = `${SW}.querySelector('select')`;
    assert.equal(await page.evaluate(`document.querySelector('label[for="' + ${pickSel}.id + '"]').textContent`), 'Pipeline');
    assert.equal(await page.evaluate(`${pickSel}.value`), 'default');
    assert.match(await page.evaluate(`${pickSel}.selectedOptions[0].textContent`), /^default \(current\)/);
    assert.equal(await applyDisabled(page), true);

    // same pipeline: unchanged
    await click(page, 'Check');
    await page.waitFor(`/already uses this pipeline/.test(${SW}.querySelector('[role=status]').textContent)`);
    assert.equal(await applyDisabled(page), true);

    // minimal: four orphans, the single candidates are preselected
    await pick(page, pickSel, 'minimal');
    await click(page, 'Check');
    await page.waitFor(`${SW}.querySelectorAll('.swTable tbody tr').length === 4`);
    const rows = await page.evaluate(`[...${SW}.querySelectorAll('.swTable tbody tr')].map((r) => ({
      node: r.querySelector('th').firstChild.textContent, text: r.querySelector('th').textContent,
      count: r.children[1].textContent, title: r.children[1].title, choice: r.querySelector('select').value,
      options: [...r.querySelectorAll('option')].map((o) => o.value) }))`);
    assert.deepEqual(rows.map((r) => r.node).sort(), ['backend-impl', 'backend-val', 'frontend-impl', 'frontend-val']);
    const byNode = Object.fromEntries(rows.map((r) => [r.node, r]));
    assert.match(byNode['backend-impl'].text, /implementor/);
    assert.equal(byNode['backend-impl'].count, '1 worker');
    assert.equal(byNode['backend-impl'].title, 'api');
    assert.deepEqual(byNode['backend-impl'].options, ['', 'impl']);
    assert.equal(byNode['frontend-val'].choice, 'val');
    await page.waitFor(`/dropped: frontend-impl/.test(${SW}.querySelector('.swDropped').textContent)`);
    assert.equal(await applyDisabled(page), false, 'single candidates are preselected');
    // clearing one choice disables Apply again
    await pick(page, `${SW}.querySelector('select[data-node=backend-val]')`, '');
    assert.equal(await applyDisabled(page), true);
    await pick(page, `${SW}.querySelector('select[data-node=backend-val]')`, 'val');
    await page.waitFor(`![...${SW}.querySelectorAll('button')].find((b) => b.textContent === 'Apply').disabled`);
    await page.evaluate(`${SW}.scrollIntoView()`);
    await shot('remap-dialog-1100.png');

    // 375 px with the dialog open
    await page.setViewport(375, 900);
    assert.ok(await page.evaluate("document.documentElement.scrollWidth <= 376"), 'no horizontal scroll at 375 px');
    assert.ok(await page.evaluate(`${SW}.getBoundingClientRect().right <= 375`));
    await page.evaluate(`${SW}.scrollIntoView()`);
    await shot('remap-dialog-375.png');
    await page.setViewport(1100, 1100);

    // apply: the graph and the settings rows follow
    await click(page, 'Apply');
    await page.waitFor(`/Pipeline changed to minimal\\./.test(${SW}.querySelector('[role=status]').textContent)`);
    assert.match(await page.evaluate(`${SW}.querySelector('[role=status]').textContent`), /Pipeline changed to minimal\. The planner was told\.$/);
    assert.deepEqual(await page.evaluate(`[...${PANE}.querySelectorAll('svg.pipeGraph .pgNode')].map((g) => g.dataset.node)`),
      ['planner', 'impl', 'val', 'integration']);
    assert.deepEqual(await page.evaluate(`[...${PANE}.querySelectorAll('.phaseRow .phaseName')].map((r) => r.textContent.split(' ')[0])`),
      ['planner', 'impl', 'val', 'integration']);
    assert.equal(await page.evaluate(`${PANE}.querySelectorAll('svg.pipeGraph').length`), 1);
    assert.equal(await page.evaluate(`${SW}.querySelectorAll('.swTable').length`), 0);
    assert.equal(await page.evaluate(`${pickSel}.value`), 'minimal');
    assert.match(await page.evaluate(`${pickSel}.selectedOptions[0].textContent`), /^minimal \(current\)/);
    assert.equal(await applyDisabled(page), true);
    const line = require("../server").lines.get(fx.lineId);
    assert.equal(line.graph.name, 'minimal');
    assert.deepEqual([...line.workers.values()].map((w) => w.node).sort(), ['impl', 'impl', 'integration', 'val', 'val']);
    await page.evaluate(`${PANE}.scrollIntoView()`);
    await shot('after-apply-1100.png');
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
});

test("pipeline switch: a running worker blocks the change", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    seedWorkers(require("../server").lines.get(fx.lineId), { running: true });
    page = await open(fx, t);
    if (!page) return;
    await pick(page, `${SW}.querySelector('select')`, 'minimal');
    await click(page, 'Check');
    await page.waitFor(`/running/.test(${SW}.querySelector('[role=alert]').textContent)`);
    const text = await page.evaluate(`${SW}.querySelector('[role=alert]').textContent`);
    assert.match(text, /api/);
    assert.match(text, /Wait until they finish or stop them/);
    assert.equal(await applyDisabled(page), true);
    assert.equal(await page.evaluate(`${SW}.querySelectorAll('.swTable').length`), 0);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
});
