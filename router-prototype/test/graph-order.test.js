"use strict";
// Integration validators in the line graph: time order, merged ids.
const test = require("node:test");
const assert = require("node:assert/strict");
const pipelineUiModule = require("../web/pipeline-ui.js");
const { integrationMerged } = require("../line-graph");

test("integrationMerged: unique worker ids in manifest order, only for integration workers", () => {
  const g = { kind: "integration", integration: { repos: [
    { name: "api", branches: [{ workerId: "a" }, { workerId: "b" }] },
    { name: "web", branches: [{ workerId: "b" }, { workerId: "c", sha: "x" }] }] } };
  assert.deepEqual(integrationMerged(g), ["a", "b", "c"]);
  assert.deepEqual(integrationMerged({ ...g, kind: "standard" }), []);
});

test("integrationMerged: no manifest, bad shapes and null give an empty list", () => {
  assert.deepEqual(integrationMerged(null), []);
  assert.deepEqual(integrationMerged({ kind: "integration" }), []);
  assert.deepEqual(integrationMerged({ kind: "integration", integration: { repos: "x" } }), []);
  assert.deepEqual(integrationMerged({ kind: "integration",
    integration: { repos: [null, { branches: [null, {}, { workerId: 3 }] }] } }), []);
});

// spec tokens: "I<n>" implementor, "v<n>" validator of implementor n, "G" / "G:<ids>" integration.
// The default pipeline columns: implementors 1, validators 2, integration 3.
const DEFAULT_GRAPH = { nodes: { impl: {}, val: {}, integ: {} }, columns: { planner: 0, impl: 1, val: 2, integ: 3 } };
function layoutOf(spec, hide) {
  let g = 0;
  const workers = spec.split(/\s+/).map((tok) => {
    if (tok[0] === "I") return { id: tok, node: "impl" };
    if (tok[0] === "v") return { id: "v" + (++g) + "_" + tok.slice(1), node: "val", role: "validator", validates: "I" + tok.slice(1) };
    const merged = tok.includes(":") ? tok.split(":")[1].split(",") : undefined;
    return { id: "G" + (++g), node: "integ", role: "validator", kind: "integration", ...(merged ? { merged } : {}) };
  });
  return { workers, result: pipelineUiModule.buildGraphLanes(workers, hide, DEFAULT_GRAPH) };
}
const laneRows = (r) => r.lanes.map((l) => [l.startRow, l.rowCount]);
const rowOf = (r, id) => r.placed.find((e) => e.worker.id === id).row;

test("default graph: lanes group validators under their implementor", () => {
  const { result } = layoutOf("I1 I2 v1 v2 v2");
  assert.deepEqual(laneRows(result), [[0, 1], [2, 2]]);
  assert.equal(result.totalRows, 4);
  assert.deepEqual(result.columns, [1, 2]);
  assert.deepEqual(result.unplaced, []);
});

test("an integration follows its wave and later lanes start below it", () => {
  const { result } = layoutOf("I1 I2 v1 v2 G I3 v3");
  assert.deepEqual(laneRows(result), [[0, 1], [2, 1], [6, 1]]);
  assert.equal(rowOf(result, "G3"), 4);
  assert.equal(result.totalRows, 7);
  assert.deepEqual(result.columns, [1, 2, 3]);
});

test("two integrations after the same lane stack in creation order", () => {
  const { result } = layoutOf("I1 v1 G G I2 v2");
  assert.deepEqual([rowOf(result, "G2"), rowOf(result, "G3")], [2, 3]);
  assert.deepEqual(laneRows(result), [[0, 1], [5, 1]]);
});

test("a manifest merged list anchors the integration exactly", () => {
  const { result } = layoutOf("I1 I2 I3 G:I1,I2");
  assert.equal(rowOf(result, "G1"), 4);
  assert.deepEqual(laneRows(result), [[0, 1], [2, 1], [6, 1]]);
});

test("old integration anchors at the last implementor validated before it", () => {
  const { result } = layoutOf("I1 I2 I3 v1 v2 G v3 G");
  assert.ok(rowOf(result, "G3") < result.lanes[2].startRow);
  assert.ok(rowOf(result, "G5") > result.lanes[2].startRow);
});

test("an integration with no manifest and no earlier validator stays at the bottom", () => {
  const { result } = layoutOf("I1 I2 G v1 v2");
  assert.deepEqual(laneRows(result), [[0, 1], [2, 1]]);
  assert.equal(rowOf(result, "G1"), 4);
  assert.equal(result.totalRows, 5);
});

test("a validator without a source starts its own lane in creation order", () => {
  const { workers } = layoutOf("I1 v1");
  workers.push({ id: "orph", node: "val", role: "validator", validates: "gone" });
  const r = pipelineUiModule.buildGraphLanes(workers, false, DEFAULT_GRAPH);
  assert.deepEqual(laneRows(r), [[0, 1], [2, 1]]);
});

test("hideFailed keeps the inference from hidden validators and gives no row to a hidden integration", () => {
  const workers = [{ id: "I1", node: "impl" }, { id: "I2", node: "impl" },
    { id: "va", node: "val", role: "validator", validates: "I1" },
    { id: "vb", node: "val", role: "validator", validates: "I2", status: "failed" },
    { id: "G", node: "integ", role: "validator", kind: "integration" },
    { id: "Gbad", node: "integ", role: "validator", kind: "integration", status: "failed" }];
  const hidden = pipelineUiModule.buildGraphLanes(workers, true, DEFAULT_GRAPH);
  assert.deepEqual(hidden.placed.map((e) => e.worker.id), ["I1", "I2", "va", "G"]);
  assert.deepEqual(laneRows(hidden), [[0, 1], [2, 1]]);
  assert.equal(rowOf(hidden, "G"), 4);
});

test("real line shape: 5 implementors then validators and integrations give ordered rows after their lanes", () => {
  const impls = [1, 2, 3, 4, 5].map((n) => ({ id: "I" + n, node: "impl" }));
  const vOrder = [1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 5, 1, 2, 3, 4, 5];
  const pattern = "vvvvvGvvGvvvGvGGGGvvG";
  let vi = 0, gi = 0;
  const rest = [...pattern].map((c) => c === "v"
    ? { id: "v" + vi, node: "val", role: "validator", validates: "I" + vOrder[vi++] }
    : { id: "G" + gi++, node: "integ", role: "validator", kind: "integration" });
  const r = pipelineUiModule.buildGraphLanes([...impls, ...rest], false, DEFAULT_GRAPH);
  const integrations = r.placed.filter((e) => e.worker.kind === "integration");
  assert.equal(integrations.length, 8);
  for (let i = 1; i < integrations.length; i++) assert.ok(integrations[i].row > integrations[i - 1].row);
  integrations.forEach((e) => {
    assert.notEqual(e.lane, null);
    assert.ok(e.row >= r.lanes[e.lane].startRow + r.lanes[e.lane].rowCount);
  });
  assert.equal(integrations[0].lane, 4);
});
