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
const choreo = require("./choreo-fixtures");
const checks = require("./fixtures/choreo-graph-checks");

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

    // graph: one box per node, one arrow per relation, report edges dashed
    const svg = `${PANE}.querySelector('svg.pipeGraph')`;
    assert.equal(await page.evaluate(`${svg}.getAttribute('role')`), 'img');
    assert.match(await page.evaluate(`${svg}.querySelector('title').textContent`), /default/);
    assert.deepEqual(await page.evaluate(`[...${svg}.querySelectorAll('.pgNode')].map((g) => g.dataset.node)`), NODE_IDS);
    assert.equal(await page.evaluate(`${svg}.querySelectorAll('.pgNode rect').length`), 6);
    assert.equal(await page.evaluate(`${svg}.querySelectorAll('path.pgEdge').length`), 14);
    assert.equal(await page.evaluate(`${svg}.querySelectorAll('path.pgEdge[marker-end]').length`), 14);
    assert.equal(await page.evaluate(`${svg}.querySelectorAll('path.pgEdge.dashed').length`), 5);
    const labels = await page.evaluate(`[...${svg}.querySelectorAll('.pgEdgeLabel')].map((l) => l.textContent)`);
    assert.equal(labels.filter((l) => l === 'report').length, 5);
    assert.equal(labels.filter((l) => l === 'start, feedback, accept').length, 2);
    assert.match(await page.evaluate(`${svg}.querySelector('[data-node=planner]').textContent`), /planner.*\/ /);
    // text list of the edges and the structure note
    const edgeLines = await page.evaluate(`[...${PANE}.querySelectorAll('.pipeEdgesText li')].map((l) => l.textContent)`);
    assert.equal(edgeLines.length, 14);
    assert.equal(edgeLines[0], 'planner -> backend-impl: start, feedback, accept');
    assert.match(await page.evaluate(`${PANE}.innerText`), /Choose another pipeline to change the graph\./);
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
    await page.waitFor(`/Saved\\. The next run of every node uses these settings\\./.test(${PANE}.innerText)`);
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

// P5: pipelines 1 and 2, optional nodes and the remove-first text on the Pipeline tab.
const openTab = async (page) => {
  await page.waitFor("/browser[- ]line/i.test(document.body.innerText)");
  await page.evaluate("[...document.querySelectorAll('button.tabBtn')].find((b) => b.textContent === 'Pipeline').click()");
  await page.waitFor(`${PANE} && !${PANE}.hidden && ${PANE}.querySelector('svg.pipeGraph')`);
};
const countIn = (page, sel) => page.evaluate(`${PANE}.querySelectorAll(${JSON.stringify(sel)}).length`);

async function openWithGraph(t, fx, graph, setup) {
  const line = require("../server").lines.get(fx.lineId);
  line.graph = graph;
  if (setup) setup(line);
  try { return await openPage(fx.url, { initScript: STUBS }); }
  catch (e) {
    if (e.code === "BROWSER_UNAVAILABLE") { t.skip("Chrome is missing: " + e.message); return null; }
    throw e;
  }
}

test("pipeline tab: pipelines 1 and 2 show wait badge, edge styles, fan-out, relations text and fit", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    page = await openWithGraph(t, fx, choreo.resolve(choreo.CHAIN));
    if (!page) return;
    const shots = process.env.PIPELINE_TAB_SHOTS;
    if (shots) fs.mkdirSync(shots, { recursive: true });
    const shot = async (name) => { if (shots) await page.screenshot(path.join(shots, name)); };
    await page.setViewport(1280, 1100);
    await openTab(page);
    assert.equal(await page.evaluate(`${PANE}.querySelector('.pgNode.wait .node-badge-wait').textContent`), "wait");
    assert.equal(await countIn(page, "path.pgEdge.edge-handoff"), 2);
    assert.equal(await countIn(page, "path.pgEdge.edge-rework"), 1);
    assert.equal(await countIn(page, "path.pgEdge.edge-arrive"), 1);
    await checks.checkEdgeStyles(page, ".pipePane");
    assert.deepEqual(await page.evaluate(`[...${PANE}.querySelectorAll('.pipeEdgesText li')].map((l) => l.textContent)`), checks.CHAIN_EDGE_LINES);
    assert.equal(await countIn(page, ".phaseRow"), 5, "one settings row for each node");
    await checks.checkFit(page, ".pipePane", 1280);
    await shot("tab-chain-1280-before-scroll.png");
    await checks.scrollRight(page, ".pipePane .pipeGraphBox");
    await shot("tab-chain-1280-after-scroll.png");
    await page.setViewport(320, 900);
    await page.evaluate(`${PANE}.querySelector('.pipeGraphBox').scrollIntoView()`);
    await checks.checkFit(page, ".pipePane", 320);
    await shot("tab-chain-320-before-scroll.png");
    await checks.scrollRight(page, ".pipePane .pipeGraphBox");
    await shot("tab-chain-320-after-scroll.png");
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
});

test("pipeline tab: pipeline 2 draws the fan-out in one column", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    page = await openWithGraph(t, fx, choreo.resolve(choreo.STAGE));
    if (!page) return;
    await page.setViewport(1280, 1100);
    await openTab(page);
    await checks.checkEdgeStyles(page, ".pipePane");
    await checks.checkStage(page, ".pipePane");
    await checks.checkFit(page, ".pipePane", 1280);
    assert.equal(await countIn(page, ".phaseRow"), 6, "one settings row for each node");
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
});

test("pipeline tab: planner-only and implement-only have one settings row for each node and no error", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    page = await openWithGraph(t, fx, loadBuiltinPipeline("planner-only", fs, ROOT));
    if (!page) return;
    const line = require("../server").lines.get(fx.lineId);
    await page.setViewport(1280, 1100);
    for (const [name, nodes] of [["planner-only", 1], ["implement-only", 2]]) {
      line.graph = loadBuiltinPipeline(name, fs, ROOT);
      await page.evaluate("location.reload()");
      await openTab(page);
      assert.equal(await countIn(page, ".pgNode"), nodes, name);
      assert.equal(await countIn(page, ".phaseRow"), nodes, name);
      assert.equal(await countIn(page, ".pipeGraphBox .pipeNote"), 0, name);
      assert.deepEqual(await page.evaluate("window.__errs"), [], name);
    }
  } finally {
    if (page) await page.close();
    await fx.close();
  }
});

// Switch the line to planner-only and press Check. Return the alert text of the switch section.
async function checkSwitchTo(page, name) {
  await page.waitFor(`${PANE}.querySelectorAll('.pipeSwitch select option').length > 1`);
  await page.evaluate(`(() => { const s = ${PANE}.querySelector('.pipeSwitch select'); s.value = ${JSON.stringify(name)}; s.dispatchEvent(new Event('change')); })()`);
  await page.evaluate(`[...${PANE}.querySelectorAll('.pipeSwitch button')].find((b) => b.textContent === 'Check').click()`);
  await page.waitFor(`/Remove these workers first/.test(${PANE}.querySelector('.pipeSwitch .createErr').textContent)`);
  return page.evaluate(`${PANE}.querySelector('.pipeSwitch .createErr').textContent`);
}

async function assertSwitchBlocked(page, workers) {
  const alert = await checkSwitchTo(page, "planner-only");
  assert.match(alert, new RegExp("Remove these workers first: " + workers + "\\."));
  assert.equal(await page.evaluate(`${PANE}.querySelector('.pipeSwitch .createErr').hidden`), false);
  assert.equal(await page.evaluate(`${PANE}.querySelector('.pipeSwitch .swTable')`), null, "no remap table");
  assert.equal(await page.evaluate(`[...${PANE}.querySelectorAll('.pipeSwitch > button')].find((b) => b.textContent === 'Apply').disabled`), true);
}

test("pipeline tab: a stub answer with removeFirst shows the alert and blocks Apply", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    page = await openWithGraph(t, fx, choreo.resolve(choreo.CHAIN));
    if (!page) return;
    await page.evaluate(`(() => { const f = window.fetch; window.fetch = (url, opts) => (opts && opts.method === 'POST' && /\\/graph$/.test(String(url))
      ? Promise.resolve(new Response(JSON.stringify({ ok: false, code: 'GRAPH_REMAP_REQUIRED', orphans: [{ node: 'impl', workerNames: ['api', 'ui'] }],
        removeFirst: ['api', 'ui'], droppedSettings: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : f.call(window, url, opts)); })()`);
    await openTab(page);
    await assertSwitchBlocked(page, "api, ui");
  } finally {
    if (page) await page.close();
    await fx.close();
  }
});

test("pipeline tab: a real line with a stored implementor cannot switch to planner-only", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    page = await openWithGraph(t, fx, loadBuiltinPipeline("implement-only", fs, ROOT), (line) => {
      line.workers.set("impl-1", { id: "w-impl-1", name: "impl-1", node: "impl", status: "completed", child: null });
    });
    if (!page) return;
    await openTab(page);
    await assertSwitchBlocked(page, "impl-1");
    assert.equal(require("../server").lines.get(fx.lineId).graph.name, "implement-only", "the line did not change");
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
});
