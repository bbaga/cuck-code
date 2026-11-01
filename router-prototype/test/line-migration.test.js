"use strict";

// Load-time migration of old line data (task D9a): normalizeLine is pure and idempotent.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeLine, loadBuiltinPipeline, phaseOfType } = require("../line-graph");
const { resolveNodeSettings, resolvePipeline } = require("../pipeline-config");
const { renderReports, kindOfNode } = require("../report-interaction");
const { startRouter, stopRouter, wait } = require("./fixtures/router-process");

const ROOT = path.join(__dirname, "..");
const resolved = loadBuiltinPipeline("default", fs, ROOT);
const clone = (x) => JSON.parse(JSON.stringify(x));

function renderReport(worker, m) {
  if (!kindOfNode(m.graph, worker.node)) return null;
  const item = renderReports({ graph: m.graph, worker, report: worker.lastRunText || "", timedOut: false,
    source: null }).find((r) => r.target === "starter");
  return item ? item.text : null;
}
function run(meta) {
  const logs = [];
  const out = normalizeLine(meta, resolved, { renderReport, now: () => 1,
    log: (level, event, f) => logs.push({ level, event, ...f }) });
  return { out, logs };
}
const impl = (over = {}) => ({ id: "i1", name: "api", role: "implementor", persona: "backend", status: "completed", branch: "b/api",
  runGeneration: 1, lastCompletedInvocationId: "inv-1", lastRunText: "All done.", ...over });
const oldRequest = (over = {}) => ({ id: "req-1", text: "IMPLEMENTOR REPORT old criteria text", noticeId: "n1",
  source: { workerId: "i1", invocationId: "inv-1", runId: 1, report: "All done." }, ...over });

test("legacy pipeline settings are copied to every node of the phase, and equal the old resolution", () => {
  const pipeline = { planner: { harness: "claude", model: "opus", maxContext: 5000 },
    implementor: { model: "sonnet", effort: "high", maxContext: 9000 }, validator: { timeLimit: 600, maxContext: 1 },
    integration: { model: "haiku" } };
  const graphOnly = { id: "L", graph: clone(resolved), pipeline, workers: [] };
  const { out, logs } = run(graphOnly);
  assert.deepEqual(out.nodeSettings["backend-impl"], pipeline.implementor);
  assert.deepEqual(out.nodeSettings["frontend-impl"], pipeline.implementor);
  assert.equal("maxContext" in out.nodeSettings["backend-val"], false, "fresh node drops maxContext");
  assert.equal(out.nodeSettings["backend-val"].timeLimit, 600);
  assert.ok(logs.some((l) => l.event === "boot.migrate" && l.step === "pipeline-to-node-settings"));
  // The effective settings equal the old per-phase resolution (env-free).
  const env = {};
  const oldResult = resolvePipeline({ graph: clone(resolved), pipeline }, env);
  for (const [id, node] of Object.entries(out.graph.nodes)) {
    const phase = phaseOfType(out.graph, node.type);
    assert.deepEqual(resolveNodeSettings(out, id, env), oldResult[phase], `node ${id}`);
  }
  // An existing node entry wins.
  const kept = run({ ...graphOnly, nodeSettings: { "backend-impl": { model: "own" } } }).out;
  assert.deepEqual(kept.nodeSettings["backend-impl"], { model: "own" });
  assert.deepEqual(kept.nodeSettings["frontend-impl"], pipeline.implementor);
});

test("validationSkipped becomes an acceptedRuns entry once", () => {
  const w = impl({ validationSkipped: { runId: 1, invocationId: "inv-1" } });
  const { out, logs } = run({ id: "L", graph: clone(resolved), nodeSettings: {}, workers: [w] });
  assert.deepEqual(out.workers[0].acceptedRuns, [{ runId: 1, invocationId: "inv-1", by: "migration" }]);
  assert.ok(logs.some((l) => l.step === "validation-skipped-to-accepted-run"));
  const same = run({ id: "L", graph: clone(resolved), nodeSettings: {},
    workers: [impl({ validationSkipped: { runId: 1, invocationId: "inv-1" },
      acceptedRuns: [{ runId: 1, invocationId: "inv-1", by: "planner" }] })] }).out;
  assert.equal(same.workers[0].acceptedRuns.length, 1);
});

test("workers without a node get one; a node missing from the graph warns and keeps the worker", () => {
  const { out, logs } = run({ id: "L", graph: clone(resolved), nodeSettings: {},
    workers: [impl(), impl({ id: "i2", name: "ui", persona: "frontend" }),
      impl({ id: "i3", name: "ghost", node: "removed-node" })] });
  assert.deepEqual(out.workers.map((w) => w.node), ["backend-impl", "frontend-impl", "removed-node"]);
  const warn = logs.filter((l) => l.level === "warn" && l.step === "worker-node-unknown");
  assert.deepEqual(warn.map((l) => l.workerId), ["i3"]);
});

test("old-style planner requests become report requests; a gone worker drops the request", () => {
  const meta = { id: "L", graph: clone(resolved), nodeSettings: {}, workers: [impl()],
    plannerQueue: [oldRequest(), oldRequest({ id: "req-2", source: { workerId: "gone", invocationId: "x", runId: 1, report: "r" } }),
      { id: "req-3", text: "plain user text", source: null }],
    activePlannerRequest: oldRequest({ id: "req-active" }) };
  const { out, logs } = run(meta);
  assert.deepEqual(out.plannerQueue.map((r) => r.id), ["req-1", "req-3"]);
  const converted = out.plannerQueue[0];
  assert.equal(converted.flow, "interactions");
  assert.equal(converted.source, null);
  assert.equal(converted.noticeId, "n1");
  assert.match(converted.text, /IMPLEMENTOR REPORT - 'api' \(workerId i1/);
  assert.match(converted.text, /All done\./);
  assert.match(converted.text, /Start a validator/);
  assert.equal(out.activePlannerRequest.id, "req-active");
  assert.equal(out.activePlannerRequest.flow, "interactions");
  assert.ok(logs.some((l) => l.step === "planner-request-dropped" && l.requestId === "req-2"));
  assert.equal(logs.filter((l) => l.step === "planner-request-to-report").length, 2);
  // A request of a worker without a completed run is kept as it is.
  const kept = run({ ...meta, workers: [impl({ status: "stopped" })], plannerQueue: [oldRequest()],
    activePlannerRequest: null }).out;
  assert.equal(kept.plannerQueue[0].source.workerId, "i1");
  // A worker the template cannot render for is kept too, with a warning and no crash.
  const bad = run({ ...meta, workers: [impl({ branch: undefined })], plannerQueue: [oldRequest()],
    activePlannerRequest: null });
  assert.equal(bad.out.plannerQueue[0].source.workerId, "i1");
  assert.ok(bad.logs.some((l) => l.step === "planner-request-render-failed"));
});

test("pendingValidations become one planner request each and the list is cleared", () => {
  const meta = { id: "L", graph: clone(resolved), nodeSettings: {}, workers: [impl()],
    plannerQueue: [{ id: "q", text: "t", source: null }],
    pendingValidations: [
      { implWorkerId: "i1", invocationId: "inv-1", runId: 1, report: "All done.", criteria: "The endpoint returns 200." },
      { implWorkerId: "gone", invocationId: "inv-9", runId: 2, report: "r", criteria: "c" }] };
  const { out, logs } = run(meta);
  assert.deepEqual(out.pendingValidations, []);
  assert.equal(out.plannerQueue.length, 2);
  const r = out.plannerQueue[1];
  assert.equal(r.flow, "interactions");
  assert.equal(r.source, null);
  assert.match(r.text, /'api' \(workerId i1\)/);
  assert.match(r.text, /did not start/);
  assert.match(r.text, /The endpoint returns 200\./);
  assert.match(r.text, /start on the validator node 'backend-val'.*implementor i1 as source.*accept/s);
  assert.ok(logs.some((l) => l.step === "pending-validation-dropped" && l.workerId === "gone"));
});

test("normalizeLine is idempotent, pure, and handles a line without a graph", () => {
  const old = { id: "L", pipeline: { implementor: { model: "m" } }, workers: [
    impl({ validationSkipped: { runId: 1, invocationId: "inv-1" } })],
  plannerQueue: [oldRequest()],
  pendingValidations: [{ implWorkerId: "i1", invocationId: "inv-1", runId: 1, report: "r", criteria: "c" }] };
  const before = JSON.stringify(old);
  const once = run(old).out;
  assert.equal(JSON.stringify(old), before, "input is not changed");
  const twice = run(clone(once));
  assert.deepEqual(twice.out, once);
  assert.deepEqual(twice.logs.filter((l) => l.level === "info"), [], "nothing is converted twice");
  assert.equal(once.graph.name, "default");
  assert.equal(once.nodeSettings["backend-impl"].model, "m");
  assert.equal(once.plannerQueue.length, 2);
});

test("a router converts old-format lines at boot", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "line-migration-"));
  const linesDir = path.join(root, "lines");
  const dir = path.join(linesDir, "old-b");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "line.json"), JSON.stringify({
    id: "old-b", name: "Old B", layout: 2, started: true, planApproved: false, repos: [],
    graph: clone(resolved), nodeSettings: {},
    pipeline: { implementor: { model: "sonnet", effort: "high" }, validator: { timeLimit: 600 } },
    workers: [impl({ validationSkipped: { runId: 1, invocationId: "inv-1" }, repo: null, branch: "b/api",
      worktreePath: path.join(linesDir, "worktrees", "old-b", "api") })],
    plannerQueue: [oldRequest()],
    pendingValidations: [{ implWorkerId: "i1", invocationId: "inv-1", runId: 1, report: "r", criteria: "Check the 200." }],
  }));
  const router = await startRouter(linesDir);
  try {
    const res = await fetch(`${router.base}/api/lines`);
    const body = (await res.json()).lines.find((l) => l.id === "old-b");
    assert.ok(body, "the line loaded");
    assert.equal(body.effectiveNodeSettings["backend-impl"].model, "sonnet");
    assert.equal(body.effectiveNodeSettings["backend-val"].timeLimit, 600);
    assert.equal(body.nodeSettings["frontend-impl"].effort, "high");
    let saved;
    for (let i = 0; i < 40; i++) {
      saved = JSON.parse(fs.readFileSync(path.join(dir, "line.json"), "utf8"));
      if (saved.nodeSettings["backend-impl"]) break;
      await wait(50);
    }
    assert.deepEqual(saved.workers[0].acceptedRuns, [{ runId: 1, invocationId: "inv-1", by: "migration" }]);
    assert.deepEqual(saved.pendingValidations, []);
    const requests = [...(saved.plannerQueue || []), ...(saved.activePlannerRequest ? [saved.activePlannerRequest] : [])];
    const reports = requests.filter((r) => r.flow === "interactions" && /IMPLEMENTOR REPORT/.test(r.text));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].id, "req-1");
    assert.equal(requests.filter((r) => r.source).length, 0, "no old-style request is left");
    assert.equal(requests.filter((r) => /did not start/.test(r.text)).length, 1);
  } finally {
    await stopRouter(router);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
