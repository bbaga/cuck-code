"use strict";
// Real-browser check of the Pipeline tab for the README example cuck-ci (E1): columns from the
// server data, the relation kind checkboxes, the script node and its settings row.
// Skipped when no Chrome is available. Set PIPELINE_TAB_SHOTS=<dir> to save screenshots.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startDashboardFixture } = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");
const { loadBuiltinPipeline } = require("../line-graph");

const ROOT = path.join(__dirname, "..");
const STUBS = "window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };"
  + "window.marked = { use() {}, parse: (t) => String(t) };"
  + "window.__errs = []; window.__puts = [];"
  + "window.addEventListener('error', (e) => window.__errs.push(String(e.message)));"
  + "const __ce = console.error; console.error = (...a) => { window.__errs.push(a.join(' ')); __ce.apply(console, a); };"
  + "const __f = window.fetch; window.fetch = (url, opts) => {"
  + " if (opts && opts.method === 'PUT' && /\\/pipeline$/.test(String(url))) window.__puts.push({ url: String(url), body: opts.body });"
  + " return __f.call(window, url, opts); };";
const PANE = "document.querySelector('.pipePane')";
const SVG = PANE + ".querySelector('svg.pipeGraph')";

// The cuck-ci pipeline of the README, resolved from a temporary copy of the repository folders.
function cuckCiGraph() {
  const yaml = /```yaml\n(name: cuck-ci[\s\S]*?)```/.exec(fs.readFileSync(path.join(ROOT, "README.md"), "utf8"))[1];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cuck-ci-"));
  fs.mkdirSync(path.join(root, "pipelines"));
  for (const dir of ["node-types", "interactions"]) fs.symlinkSync(path.join(ROOT, dir), path.join(root, dir));
  fs.writeFileSync(path.join(root, "pipelines", "cuck-ci.yaml"), yaml);
  try { return loadBuiltinPipeline("cuck-ci", fs, root); } finally { fs.rmSync(root, { recursive: true }); }
}

test("pipeline tab: cuck-ci columns, kind checkboxes, script node and settings row", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    require("../server").lines.get(fx.lineId).graph = cuckCiGraph();
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    const shots = process.env.PIPELINE_TAB_SHOTS;
    if (shots) fs.mkdirSync(shots, { recursive: true });
    const shot = async (name) => { if (shots) await page.screenshot(path.join(shots, name)); };
    const open = async () => {
      await page.waitFor("/browser[- ]line/i.test(document.body.innerText)");
      await page.evaluate("[...document.querySelectorAll('button.tabBtn')].find((b) => b.textContent === 'Pipeline').click()");
      await page.waitFor(`${PANE} && !${PANE}.hidden && ${SVG}`);
    };
    await page.setViewport(1400, 1000);
    await open();

    // five columns, taken from the server: planner, backend-impl, ci, backend-val, integration
    const xs = await page.evaluate(`Object.fromEntries([...${SVG}.querySelectorAll('.pgNode')].map((g) =>
      [g.dataset.node, g.querySelector('rect').getAttribute('x')]))`);
    const order = Object.keys(xs).sort((a, b) => Number(xs[a]) - Number(xs[b]));
    assert.deepEqual(order, ["planner", "backend-impl", "ci", "backend-val", "integration"]);
    assert.equal(new Set(Object.values(xs)).size, 5);

    // the script node
    assert.equal(await page.evaluate(`${SVG}.querySelectorAll('.pgNode.script').length`), 1);
    const ci = `${SVG}.querySelector('[data-node=ci]')`;
    assert.equal(await page.evaluate(`${ci}.classList.contains('script')`), true);
    const ciText = await page.evaluate(`${ci}.textContent`);
    assert.match(ciText, /⚙ ci/);
    assert.match(ciText, /script-check · 3 scripts/);
    assert.match(ciText, /required/);

    // kind checkboxes: hiding a kind removes its edges, no node moves, the choice survives a reload
    const box = (kind) => `${PANE}.querySelector('.pgLegend input[data-kind=${kind}]')`;
    assert.equal(await page.evaluate(`[...${PANE}.querySelectorAll('.pgLegend input')].every((i) => i.checked)`), true);
    const visible = (kind) => page.evaluate(`[...${SVG}.querySelectorAll('path.pgEdge.${kind}')].filter((p) => p.style.display !== 'none').length`);
    assert.ok(await visible("checks") > 0);
    await shot("pipeline-tab-cuck-ci.png");
    await page.evaluate(`${box("checks")}.click()`);
    assert.equal(await visible("checks"), 0);
    assert.ok(await visible("after") > 0);
    assert.deepEqual(await page.evaluate(`Object.fromEntries([...${SVG}.querySelectorAll('.pgNode')].map((g) =>
      [g.dataset.node, g.querySelector('rect').getAttribute('x')]))`), xs);
    assert.equal(await page.evaluate("localStorage.getItem('pipe-graph-kinds')"), JSON.stringify(
      { interaction: true, checks: false, after: true, "accepted-work": true, required: true }));
    await page.evaluate("location.reload()");
    await open();
    assert.equal(await page.evaluate(`${box("checks")}.checked`), false);
    assert.equal(await visible("checks"), 0);

    // the script settings row: read-only, a time limit only
    const row = `${PANE}.querySelector('.scriptRow')`;
    const rowText = await page.evaluate(`${row}.innerText`);
    for (const word of ["ci", "scripts", "required", "checkout: worktree", "format", "npx prettier --check .",
      "<run root>/router-prototype", "cwd <run root>;", "timeout 300 s", "repos ml-service"]) assert.ok(rowText.includes(word), word);
    assert.equal(await page.evaluate(`${row}.querySelectorAll('select').length`), 0);
    assert.equal(await page.evaluate(`${row}.querySelectorAll('input').length`), 1);
    await page.evaluate(`${row}.scrollIntoView()`);
    await shot("pipeline-tab-script-row.png");
    await page.evaluate(`(() => { const i = document.getElementById('lp-browser-line-timelimit-ci'); i.value = '900'; })()`);
    await page.evaluate(`[...${PANE}.querySelectorAll('.pipeBtns button')].find((b) => b.textContent === 'Save settings').click()`);
    await page.waitFor(`/Saved\\./.test(${PANE}.innerText)`);
    const puts = await page.evaluate("window.__puts");
    assert.deepEqual(JSON.parse(puts[0].body), { nodeSettings: { ci: { timeLimit: 900 } } });

    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
});
