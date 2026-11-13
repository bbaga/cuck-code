"use strict";
// Real-browser check of the line graph with a script check (pipeline cuck-ci) and the check card.
// Skipped when no Chrome is available. Screenshots go to SCRIPT_CHECK_SHOTS=<dir> when set.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startDashboardFixture } = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");
const { resolvePipelineDefinition } = require("../resolve-pipeline");
const { buildCatalog } = require("../plugin-catalog");

const STUBS = "window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };"
  + "window.marked = { use() {}, parse: (t) => String(t) };"
  + "window.__errs = [];"
  + "window.addEventListener('error', (e) => window.__errs.push(String(e.message)));";

const CUCK_CI = `name: cuck-ci
start: planner
nodes:
  planner: { type: planner }
  backend-impl: { type: backend-implementor }
  backend-val: { type: backend-validator, checks: [backend-impl], after: [ci] }
  ci: { type: script-check, checks: [backend-impl], required: true, scripts: [{ name: unit, run: "true" }] }
  integration: { type: integration-validator }
edges:
  - planner -> backend-impl: start, feedback, accept
  - backend-impl -> planner: report
  - planner -> [backend-val, ci, integration]: start
  - "[backend-val, ci, integration] -> planner: report"
`;

function cuckCiGraph() {
  const catalog = buildCatalog({ builtInDir: path.join(__dirname, "..") });
  catalog.pipelines["cuck-ci"] = { layer: "managed", text: CUCK_CI };
  return resolvePipelineDefinition("cuck-ci", catalog);
}

function seed(line, logFile) {
  line.graph = cuckCiGraph();
  const done = { status: "completed", transcript: [], runGeneration: 1 };
  const results = [
    { index: 1, name: "lint", status: "pass", exitCode: 0, signal: null, durationMs: 1200, reason: null, logFile },
    { index: 2, name: "unit", status: "pass", exitCode: 0, signal: null, durationMs: 3400, reason: null, logFile: null },
    { index: 3, name: "e2e", status: "fail", exitCode: 1, signal: null, durationMs: 800, reason: "exit code 1", logFile: null },
  ];
  const workers = [
    { id: "i1", name: "backend-impl-1", node: "backend-impl", role: "implementor", persona: "backend",
      repo: "api", branch: "b/one", children: [], ...done },
    { id: "c1", name: "check-backend-impl-1", node: "ci", role: "validator", runner: "script", kind: "standard",
      validates: "i1", verdict: "fail", harness: "script", persona: "backend", branch: "b/one",
      scriptSpec: { steps: [{ name: "lint" }, { name: "unit" }, { name: "e2e" }], failFast: true, checkout: "worktree" },
      checkedCommit: "a".repeat(40), worktreePath: "/tmp/wt/one", checkResults: results, afterChecks: [], ...done },
    { id: "v1", name: "validator-backend-impl-1", node: "backend-val", role: "validator", kind: "standard",
      validates: "i1", verdict: "pass", afterChecks: ["c1"], ...done },
  ];
  for (const w of workers) line.workers.set(w.id, w);
}

test("script check: columns, edge to the validator, summary, table and log link", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "script-check-ui-"));
  const logFile = path.join(dir, "step-1.log");
  fs.writeFileSync(logFile, "lint output line\n");
  const fx = await startDashboardFixture();
  let page = null;
  try {
    seed(require("../server").lines.get(fx.lineId), logFile);
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    await page.setViewport(1100, 900);
    await page.waitFor("document.querySelectorAll('.gnode.worker').length === 2");
    assert.equal(await page.evaluate("document.body.innerText.includes('check-backend-impl-1')"), false, "failed check is hidden");
    await page.evaluate("document.querySelector('.graphToolbar input[type=checkbox], input[type=checkbox]').click()");
    await page.waitFor("document.querySelectorAll('.gnode.worker').length === 3");
    const nodes = await page.evaluate(`Object.fromEntries([...document.querySelectorAll('.gnode.worker')].map((n) => [
      n.querySelector('.nodeName').textContent, { left: n.offsetLeft, top: n.offsetTop, w: n.offsetWidth,
        cls: n.className, summary: (n.querySelector('.scriptSummary') || {}).textContent || null }]))`);
    const impl = nodes["backend-impl-1"], check = nodes["⚙ check-backend-impl-1"], val = nodes["validator-backend-impl-1"];
    assert.ok(impl && check && val, "three nodes: " + Object.keys(nodes));
    assert.ok(impl.left < check.left && check.left < val.left, "columns 1, 2 and 3 go left to right");
    assert.deepEqual([impl.top, check.top, val.top], [impl.top, impl.top, impl.top], "one lane, one row");
    assert.equal(check.summary, "2/3 ✗");
    assert.match(check.cls, /w-script/);
    // The validator edge starts at the right side of the check, not at the implementor.
    const paths = await page.evaluate("[...document.querySelectorAll('.graph svg path.edge')].map((p) => p.getAttribute('d'))");
    assert.ok(paths.some((d) => d.startsWith(`M ${check.left + check.w} `) && d.endsWith(`H ${val.left}`)),
      "edge from the check to the validator: " + paths.join(" | "));
    assert.ok(!paths.some((d) => d.startsWith(`M ${impl.left + impl.w} `) && d.endsWith(`H ${val.left}`)),
      "no edge from the implementor to the validator");

    await page.evaluate("[...document.querySelectorAll('.gnode.w-script')][0].click()");
    await page.waitFor("document.querySelector('.checkCard') && !document.querySelector('.checkCard').hidden");
    const card = await page.evaluate(`({ text: document.querySelector('.checkCard dl').textContent,
      rows: [...document.querySelectorAll('.checkCard tbody tr')].map((r) => [...r.cells].map((c) => c.textContent)) })`);
    assert.match(card.text, /scripts/);
    assert.match(card.text, /worktree of backend-impl-1: \/tmp\/wt\/one/);
    assert.match(card.text, /a{40}/);
    assert.deepEqual(card.rows.map((r) => r.slice(0, 5)), [
      ["1", "lint", "PASS", "0", "1.2 s"], ["2", "unit", "PASS", "0", "3.4 s"], ["3", "e2e", "FAIL: exit code 1", "1", "0.8 s"]]);
    assert.equal(card.rows[0][5], "log");
    assert.equal(card.rows[1][5], "");
    const logText = await page.evaluate("fetch(document.querySelector('.checkCard a').href).then((r) => r.text())");
    assert.equal(logText, "lint output line\n");

    const shots = process.env.SCRIPT_CHECK_SHOTS;
    if (shots) {
      fs.mkdirSync(shots, { recursive: true });
      await page.screenshot(path.join(shots, "script-check-line-1100.png"));
      await page.evaluate("document.querySelector('.scopeDetails').open = true");
      await page.screenshot(path.join(shots, "script-check-card-1100.png"));
    }
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await fx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
