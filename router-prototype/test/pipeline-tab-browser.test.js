"use strict";
// Real-browser check of the line Pipeline tab (D5): graph view, settings rows, save.
// Skipped when no Chrome is available. Set PIPELINE_TAB_SHOTS=<dir> to save screenshots.
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
  + "window.__errs = []; window.__puts = [];"
  + "window.addEventListener('error', (e) => window.__errs.push(String(e.message)));"
  + "window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));"
  + "const __ce = console.error; console.error = (...a) => { window.__errs.push(a.join(' ')); __ce.apply(console, a); };"
  + "const __f = window.fetch; window.fetch = (url, opts) => {"
  + " if (opts && opts.method === 'PUT' && /\\/pipeline$/.test(String(url))) window.__puts.push({ url: String(url), body: opts.body });"
  + " return __f.call(window, url, opts); };";

const PANE = "document.querySelector('.pipePane')";
const NODE_IDS = ["planner", "backend-impl", "frontend-impl", "backend-val", "frontend-val", "integration"];

test("pipeline tab: graph of the default pipeline, settings rows, save, 375 px", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    // The seeded line is built by hand, without the graph the router adds on load.
    require("../server").lines.get(fx.lineId).graph = loadBuiltinPipeline("default", fs, ROOT);
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    const shots = process.env.PIPELINE_TAB_SHOTS;
    if (shots) fs.mkdirSync(shots, { recursive: true });
    const shot = async (name) => { if (shots) await page.screenshot(path.join(shots, name)); };
    await page.setViewport(1100, 1100);
    await page.waitFor("/browser[- ]line/i.test(document.body.innerText)");
    await page.evaluate("[...document.querySelectorAll('button.tabBtn')].find((b) => b.textContent === 'Pipeline').click()");
    await page.waitFor(`${PANE} && !${PANE}.hidden && ${PANE}.querySelector('svg.pipeGraph')`);

    // graph: one box per node, one arrow per edge, report edges dashed
    const svg = `${PANE}.querySelector('svg.pipeGraph')`;
    assert.equal(await page.evaluate(`${svg}.getAttribute('role')`), 'img');
    assert.match(await page.evaluate(`${svg}.querySelector('title').textContent`), /default/);
    assert.deepEqual(await page.evaluate(`[...${svg}.querySelectorAll('.pgNode')].map((g) => g.dataset.node)`), NODE_IDS);
    assert.equal(await page.evaluate(`${svg}.querySelectorAll('.pgNode rect').length`), 6);
    assert.equal(await page.evaluate(`${svg}.querySelectorAll('path.pgEdge').length`), 10);
    assert.equal(await page.evaluate(`${svg}.querySelectorAll('path.pgEdge[marker-end]').length`), 10);
    assert.equal(await page.evaluate(`${svg}.querySelectorAll('path.pgEdge.dashed').length`), 5);
    const labels = await page.evaluate(`[...${svg}.querySelectorAll('.pgEdgeLabel')].map((l) => l.textContent)`);
    assert.equal(labels.filter((l) => l === 'report').length, 5);
    assert.equal(labels.filter((l) => l === 'start, feedback, accept').length, 2);
    assert.match(await page.evaluate(`${svg}.querySelector('[data-node=planner]').textContent`), /planner.*\/ /);
    // text list of the edges and the structure note
    const edgeLines = await page.evaluate(`[...${PANE}.querySelectorAll('.pipeEdgesText li')].map((l) => l.textContent)`);
    assert.equal(edgeLines.length, 10);
    assert.equal(edgeLines[0], 'planner -> backend-impl: start, feedback, accept');
    assert.match(await page.evaluate(`${PANE}.innerText`), /The pipeline structure of a line does not change after creation\./);
    // the old summary and the preset bar are gone
    assert.equal(await page.evaluate(`${PANE}.querySelector('.pipeCfg, .presetBar')`), null);
    assert.doesNotMatch(await page.evaluate(`${PANE}.innerText`), /Effective settings/);

    // settings rows follow the nodes; fresh-session nodes have no max context
    const rowNames = await page.evaluate(`[...${PANE}.querySelectorAll('.phaseRow .phaseName')].map((r) => r.textContent)`);
    assert.deepEqual(rowNames.map((r) => r.split(' ')[0]), NODE_IDS);
    assert.deepEqual(await page.evaluate(`[...${PANE}.querySelectorAll('.phaseRow')].map((r) => !!r.querySelector('input'))`),
      [true, true, true, false, false, false]);
    await shot('pipeline-tab-1100.png');

    // save: change the effort of two nodes
    await page.evaluate(`(() => { for (const [id, v] of [['planner', 'high'], ['backend-val', 'low']]) {
      const s = document.getElementById('lp-browser-line-effort-' + id); s.value = v; s.dispatchEvent(new Event('change')); } })()`);
    await page.evaluate(`[...${PANE}.querySelectorAll('.pipeBtns button')].find((b) => b.textContent === 'Save settings').click()`);
    await page.waitFor(`/Saved\\. The settings apply from the next run\\./.test(${PANE}.innerText)`);
    const puts = await page.evaluate("window.__puts");
    assert.equal(puts.length, 1);
    assert.match(puts[0].url, /\/api\/lines\/browser-line\/pipeline$/);
    assert.deepEqual(JSON.parse(puts[0].body), { nodeSettings: { planner: { effort: 'high' }, 'backend-val': { effort: 'low' } } });
    assert.deepEqual(require("../server").lines.get(fx.lineId).nodeSettings,
      { planner: { effort: 'high' }, 'backend-val': { effort: 'low' } });
    assert.equal(await page.evaluate("document.getElementById('lp-browser-line-effort-planner').value"), 'high');

    // revert restores the stored values
    await page.evaluate(`(() => { const s = document.getElementById('lp-browser-line-effort-planner'); s.value = 'medium'; })()`);
    await page.evaluate(`[...${PANE}.querySelectorAll('.pipeBtns button')].find((b) => b.textContent === 'Revert').click()`);
    assert.equal(await page.evaluate("document.getElementById('lp-browser-line-effort-planner').value"), 'high');

    // 375 px: the page does not scroll sideways, the graph scrolls inside its box
    await page.setViewport(375, 900);
    await shot('pipeline-tab-375.png');
    assert.ok(await page.evaluate("document.documentElement.scrollWidth <= 375 + 1"), 'no horizontal scroll at 375 px');
    assert.ok(await page.evaluate("document.body.scrollWidth <= 375 + 1"), 'body fits at 375 px');
    const box = `${PANE}.querySelector('.pipeGraphBox')`;
    assert.ok(await page.evaluate(`${box}.getBoundingClientRect().right <= 375`), 'graph box inside the viewport');
    assert.ok(await page.evaluate(`${box}.scrollWidth > ${box}.clientWidth`), 'the graph scrolls inside its box');
    await page.evaluate(`${PANE}.scrollIntoView()`);

    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
});
