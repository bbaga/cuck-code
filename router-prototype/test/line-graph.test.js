"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PHASE_TYPES, phaseOfType, migrateLine, loadBuiltinPipeline, graphView, isLineDirectory, RESERVED_LINES_SUBDIRS } = require("../line-graph");
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
  assert.deepEqual(view.nodes.planner, { type: "planner", phase: "planner", runner: "agent", checks: [], after: [],
    workspace: "coordinator", requires: [] });
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

test("isLineDirectory skips worktrees, plugins and hidden folders but accepts a line folder", () => {
  const dir = (name, isDir = true) => ({ name, isDirectory: () => isDir });
  assert.equal(isLineDirectory(dir("16c33bf0-3efa-4c79-825b-963b10b32fdc")), true);
  for (const name of ["worktrees", "plugins", ".deleted", ".system-prompts"]) assert.equal(isLineDirectory(dir(name)), false, name);
  assert.equal(isLineDirectory(dir("pipeline-presets.json", false)), false, "a file is not a line");
  assert.equal(isLineDirectory(null), false);
  assert.ok(RESERVED_LINES_SUBDIRS.has("plugins") && RESERVED_LINES_SUBDIRS.has("worktrees"));
});

// ---- planGraphChange ----
const { planGraphChange } = require("../line-graph");
const minimal = loadBuiltinPipeline("minimal", fs, ROOT);
const clone = (v) => JSON.parse(JSON.stringify(v));

function planLine(extra = {}) {
  return { graph: clone(resolved), nodeSettings: {}, workers: [
    { id: "i1", name: "api", role: "implementor", node: "backend-impl" },
    { id: "i2", name: "ui", role: "implementor", node: "frontend-impl" },
    { id: "v1", name: "api-val", role: "validator", node: "backend-val" },
    { id: "g1", name: "int", role: "validator", kind: "integration", node: "integration" },
  ], ...extra };
}
const FULL_REMAP = { "backend-impl": "impl", "frontend-impl": "impl", "backend-val": "val" };

test("planGraphChange: the same graph is a no-op", () => {
  const line = planLine({ nodeSettings: { planner: { model: "x" } } });
  const out = planGraphChange({ line, newGraph: clone(resolved), remap: {} });
  assert.equal(out.ok, true);
  assert.equal(out.unchanged, true);
  assert.deepEqual(out.moves, []);
});

test("planGraphChange: orphans list workers and candidates of the same phase", () => {
  const out = planGraphChange({ line: planLine(), newGraph: minimal, remap: {} });
  assert.equal(out.ok, false);
  assert.equal(out.code, "GRAPH_REMAP_REQUIRED");
  const byNode = Object.fromEntries(out.orphans.map((o) => [o.node, o]));
  assert.deepEqual(Object.keys(byNode).sort(), ["backend-impl", "backend-val", "frontend-impl"]);
  assert.deepEqual(byNode["backend-impl"], { node: "backend-impl", phase: "implementor", workers: 1,
    workerNames: ["api"], candidates: ["impl"] });
  assert.deepEqual(byNode["backend-val"].candidates, ["val"]);
  // a partial remap lists only what is still missing
  const partial = planGraphChange({ line: planLine(), newGraph: minimal, remap: { "backend-impl": "impl" } });
  assert.deepEqual(partial.orphans.map((o) => o.node).sort(), ["backend-val", "frontend-impl"]);
});

test("planGraphChange: a valid remap gives the moves and keeps the nodes with the same id and phase", () => {
  const out = planGraphChange({ line: planLine(), newGraph: minimal, remap: FULL_REMAP });
  assert.equal(out.ok, true);
  assert.equal(out.unchanged, false);
  assert.deepEqual(out.moves, [
    { workerId: "i1", name: "api", from: "backend-impl", to: "impl" },
    { workerId: "i2", name: "ui", from: "frontend-impl", to: "impl" },
    { workerId: "v1", name: "api-val", from: "backend-val", to: "val" },
  ]);
});

test("planGraphChange: every invalid remap kind", () => {
  const bad = (remap) => planGraphChange({ line: planLine(), newGraph: minimal, remap: { ...FULL_REMAP, ...remap } });
  const kinds = [
    [{ integration: "impl" }, /not an orphan/],
    [{ ghost: "impl" }, /unknown source node 'ghost'/],
    [{ "backend-impl": "nowhere" }, /no such node/],
    [{ "backend-impl": "val" }, /phase/],
    [{ "backend-impl": 7 }, /no such node/],
  ];
  for (const [remap, pattern] of kinds) {
    const out = bad(remap);
    assert.equal(out.ok, false);
    assert.equal(out.code, "GRAPH_REMAP_INVALID");
    assert.ok(out.errors.some((e) => pattern.test(e)), JSON.stringify(out.errors));
  }
  assert.equal(planGraphChange({ line: planLine(), newGraph: minimal, remap: [] }).code, "GRAPH_REMAP_INVALID");
});

test("planGraphChange: settings are kept, carried to the target or dropped", () => {
  const line = planLine({ nodeSettings: {
    planner: { model: "opus" },
    integration: { model: "haiku", maxContext: 5000 },
    "backend-impl": { model: "sonnet", maxContext: 9000 },
    "frontend-impl": { model: "haiku" },
    "backend-val": { timeLimit: 600, maxContext: 100 },
    "frontend-val": { timeLimit: 300 },
  } });
  const out = planGraphChange({ line, newGraph: minimal, remap: FULL_REMAP });
  assert.equal(out.ok, true);
  assert.deepEqual(out.nodeSettings.planner, { model: "opus" });
  assert.deepEqual(out.nodeSettings.integration, { model: "haiku" }, "maxContext dropped for a fresh node");
  assert.deepEqual(out.nodeSettings.impl, { model: "sonnet", maxContext: 9000 }, "first remapped entry wins");
  assert.deepEqual(out.nodeSettings.val, { timeLimit: 600 }, "fresh node: no maxContext");
  assert.deepEqual(out.droppedSettings.sort(), ["frontend-impl", "frontend-val"]);
});

test("planGraphChange: a target with its own entry keeps it", () => {
  const line = planLine({ nodeSettings: { "backend-impl": { model: "a" }, impl: { model: "b" } } });
  const out = planGraphChange({ line, newGraph: clone(minimal), remap: FULL_REMAP });
  assert.deepEqual(out.nodeSettings.impl, { model: "b" });
  assert.deepEqual(out.droppedSettings, ["backend-impl"]);
});

test("planGraphChange: workers without a node do not block and are counted", () => {
  const line = planLine();
  line.workers.push({ id: "x", name: "lost", role: "implementor", node: null });
  line.workers.push({ id: "y", name: "lost2", role: "implementor" });
  const out = planGraphChange({ line, newGraph: minimal, remap: FULL_REMAP });
  assert.equal(out.ok, true);
  assert.equal(out.unassigned, 2);
  assert.ok(out.moves.every((m) => m.workerId !== "x" && m.workerId !== "y"));
});

test("planGraphChange does not change its input", () => {
  const line = planLine({ nodeSettings: { "backend-val": { timeLimit: 1 } } });
  const before = JSON.stringify(line);
  planGraphChange({ line, newGraph: minimal, remap: FULL_REMAP });
  assert.equal(JSON.stringify(line), before);
});

// ---- script check nodes ----

test("a script-check type is in the validator phase", () => {
  const graph = { types: { "script-check": { name: "script-check" }, "my-ci": { name: "my-ci", extends: "script-check" } } };
  assert.equal(phaseOfType(graph, "script-check"), "validator");
  assert.equal(phaseOfType(graph, "my-ci"), "validator");
});

test("graphView shows runner, checks, after, workspace and requires", () => {
  const view = graphView(resolved);
  assert.deepEqual(view.nodes["backend-impl"], { type: "backend-implementor", phase: "implementor", runner: "agent",
    checks: [], after: [], workspace: "own-worktree", requires: [] });
  assert.deepEqual(view.nodes["backend-val"].checks, ["backend-impl"]);
  assert.deepEqual(view.nodes.integration.requires, ["accepted-work"]);
  assert.ok(!("scripts" in view.nodes["backend-val"]));
});

test("graphView adds the script fields of a script node as a copy", () => {
  const graph = JSON.parse(JSON.stringify(resolved));
  graph.types["script-check"] = { name: "script-check", runner: "script", workspace: "source", requires: [] };
  graph.nodes.ci = { type: "script-check", checks: ["backend-impl"], after: [], scripts: [{ name: "u", run: "x", timeout: 600 }] };
  const node = graphView(graph).nodes.ci;
  assert.equal(node.runner, "script");
  assert.deepEqual([node.failFast, node.required, node.checkout], [true, false, "worktree"]);
  assert.deepEqual(node.scripts, graph.nodes.ci.scripts);
  assert.notEqual(node.scripts, graph.nodes.ci.scripts);
});
