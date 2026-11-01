"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PHASE_TYPES, phaseOfType, migrateLine, loadBuiltinPipeline, graphView } = require("../line-graph");
const { startRouter, stopRouter } = require("./fixtures/router-process");

const ROOT = path.join(__dirname, "..");
const resolved = loadBuiltinPipeline("default", fs, ROOT);

function oldLine() {
  return {
    id: "L1", name: "Old", layout: 2,
    pipeline: {
      planner: { harness: "claude", model: "opus" },
      implementor: { model: "sonnet", effort: "high" },
      validator: { timeLimit: 600 },
      integration: { model: "haiku" },
    },
    workers: [
      { id: "i1", name: "api", role: "implementor", persona: "backend", status: "completed",
        validationSkipped: { runId: "r1", invocationId: "inv1" } },
      { id: "i2", name: "ui", role: "implementor", persona: "frontend", status: "completed" },
      { id: "v1", name: "api-val", role: "validator", validates: "i1", persona: "backend", kind: "standard" },
      { id: "v2", name: "ui-val", role: "validator", validates: "i2", persona: "frontend", kind: "standard" },
      { id: "g1", name: "integration-validator", role: "validator", kind: "integration" },
    ],
  };
}

test("PHASE_TYPES and phaseOfType follow extends to the root type", () => {
  assert.deepEqual(PHASE_TYPES, { planner: "planner", implementor: "implementor",
    validator: "validator", integration: "integration-validator" });
  assert.equal(phaseOfType(resolved, "planner"), "planner");
  assert.equal(phaseOfType(resolved, "backend-implementor"), "implementor");
  assert.equal(phaseOfType(resolved, "frontend-implementor"), "implementor");
  assert.equal(phaseOfType(resolved, "backend-validator"), "validator");
  assert.equal(phaseOfType(resolved, "integration-validator"), "integration");
  assert.equal(phaseOfType(resolved, "nope"), null);
});

test("migrateLine maps phase settings, workers and skipped validation", () => {
  const input = oldLine();
  const before = JSON.stringify(input);
  const out = migrateLine(input, resolved);
  assert.equal(JSON.stringify(input), before, "input is not changed");
  assert.equal(out.graph.name, "default");
  assert.deepEqual(out.nodeSettings, {
    planner: { harness: "claude", model: "opus" },
    "backend-impl": { model: "sonnet", effort: "high" },
    "frontend-impl": { model: "sonnet", effort: "high" },
    "backend-val": { timeLimit: 600 },
    "frontend-val": { timeLimit: 600 },
    integration: { model: "haiku" },
  });
  const node = Object.fromEntries(out.workers.map((w) => [w.id, w.node]));
  assert.deepEqual(node, { i1: "backend-impl", i2: "frontend-impl", v1: "backend-val",
    v2: "frontend-val", g1: "integration" });
  assert.deepEqual(out.workers[0].acceptedRuns, [{ runId: "r1", invocationId: "inv1", by: "migration" }]);
  assert.equal(out.workers[1].acceptedRuns, undefined);
  assert.deepEqual(out.pipeline, input.pipeline, "pipeline is kept");
});

test("migrateLine defaults the persona to backend, and is idempotent", () => {
  const out = migrateLine({ id: "x", workers: [{ id: "a", role: "implementor" }] }, resolved);
  assert.equal(out.workers[0].node, "backend-impl");
  assert.deepEqual(out.nodeSettings, {});
  const once = migrateLine(oldLine(), resolved);
  assert.equal(migrateLine(once, resolved), once);
  assert.deepEqual(migrateLine(JSON.parse(JSON.stringify(once)), resolved), once);
});

test("a new line stores the graph, and an old line.json gains it on the next save", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "line-graph-"));
  const linesDir = path.join(root, "lines");
  const legacyDir = path.join(linesDir, "legacy");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "line.json"), JSON.stringify({
    id: "legacy", name: "Legacy", layout: 2, started: true, repos: [],
    pipeline: { implementor: { model: "sonnet" } },
    // A running worker makes the router save the line at boot.
    workers: [{ id: "i1", name: "impl", role: "implementor", persona: "frontend", status: "running",
      branch: "b/impl", worktreePath: path.join(linesDir, "worktrees", "legacy", "impl"),
      validationSkipped: { runId: "r1", invocationId: "inv1" } }] }));
  const router = await startRouter(linesDir);
  try {
    const res = await fetch(router.base + "/api/lines", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "New" }) });
    assert.equal(res.status, 201);
    const { id } = await res.json();
    const saved = JSON.parse(fs.readFileSync(path.join(linesDir, id, "line.json"), "utf8"));
    assert.equal(saved.graph.name, "default");
    assert.deepEqual(saved.nodeSettings, {});

    const legacy = JSON.parse(fs.readFileSync(path.join(legacyDir, "line.json"), "utf8"));
    assert.equal(legacy.graph.name, "default");
    assert.deepEqual(legacy.nodeSettings["frontend-impl"], { model: "sonnet" });
    assert.equal(legacy.workers[0].node, "frontend-impl");
    assert.deepEqual(legacy.workers[0].acceptedRuns, [{ runId: "r1", invocationId: "inv1", by: "migration" }]);
    assert.equal(legacy.pipeline, undefined, "the old per-phase field is not written any more");
  } finally {
    await stopRouter(router);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("graphView edges carry kinds taken from the resolved interactions", () => {
  const view = graphView(resolved);
  assert.equal(view.start, "planner");
  assert.deepEqual(view.nodes.planner, { type: "planner", phase: "planner" });
  for (const edge of view.edges) {
    assert.deepEqual(Object.keys(edge.kinds), edge.interactions);
  }
  const start = view.edges.find((e) => e.from === "planner" && e.to === "backend-val");
  assert.deepEqual(start.kinds, { start: { effect: "create", trigger: "request" } });
  const rep = view.edges.find((e) => e.from === "integration" && e.to === "planner");
  assert.deepEqual(rep.kinds, { report: { effect: "deliver", trigger: "complete" } });
  assert.deepEqual(view.freshNodes, ["backend-val", "frontend-val", "integration"]);
  assert.equal(graphView(null), null);
  // the view is a copy
  view.edges[0].interactions.push("x");
  assert.ok(!resolved.edges[0].interactions.includes("x"));
});
