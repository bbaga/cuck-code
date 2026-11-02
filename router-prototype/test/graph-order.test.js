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

// spec tokens: "I<n>" implementor, "v<n>" validator of implementor n, "G" / "G:<ids>" integration
function layoutOf(spec, hide) {
  let g = 0;
  const workers = spec.split(/\s+/).map((tok) => {
    if (tok[0] === "I") return { id: tok };
    if (tok[0] === "v") return { id: "v" + (++g) + "_" + tok.slice(1), role: "validator", validates: "I" + tok.slice(1) };
    const merged = tok.includes(":") ? tok.split(":")[1].split(",") : undefined;
    return { id: "G" + (++g), role: "validator", kind: "integration", ...(merged ? { merged } : {}) };
  });
  return { workers, result: pipelineUiModule.buildGraphLanes(workers, hide) };
}
const laneRows = (r) => r.lanes.map((l) => [l.startRow, l.rowCount]);

test("without integration the old fields are unchanged and the new lists are empty", () => {
  const { result } = layoutOf("I1 I2 v1 v2 v2");
  assert.deepEqual(laneRows(result), [[0, 1], [2, 2]]);
  assert.equal(result.totalRows, 4);
  assert.deepEqual(result.integrations, []);
  assert.deepEqual(result.integrationRows, []);
  assert.deepEqual(result.integrationAnchors, []);
  assert.equal(result.integrationStartRow, null);
});

test("an integration follows its wave and later lanes start below it", () => {
  const { result } = layoutOf("I1 I2 v1 v2 G I3 v3");
  assert.deepEqual(laneRows(result), [[0, 1], [2, 1], [6, 1]]);
  assert.deepEqual(result.integrationRows, [4]);
  assert.deepEqual(result.integrationAnchors, [1]);
  assert.equal(result.integrationStartRow, null);
  assert.equal(result.totalRows, 7);
});

test("two integrations after the same lane stack in creation order", () => {
  const { result } = layoutOf("I1 v1 G G I2 v2");
  assert.deepEqual(result.integrations.map((g) => g.id), ["G2", "G3"]);
  assert.deepEqual(result.integrationRows, [2, 3]);
  assert.deepEqual(result.integrationAnchors, [0, 0]);
  assert.deepEqual(laneRows(result), [[0, 1], [5, 1]]);
});

test("a manifest merged list anchors the integration exactly", () => {
  const { result } = layoutOf("I1 I2 I3 G:I1,I2");
  assert.deepEqual(result.integrationAnchors, [1]);
  assert.deepEqual(result.integrationRows, [4]);
  assert.deepEqual(laneRows(result), [[0, 1], [2, 1], [6, 1]]);
});

test("old integration, restart order: implementors first, validators and integrations after", () => {
  const { result } = layoutOf("I1 I2 I3 I4 I5 v1 v2 v3 v4 v5 G v1 v2 G v3 v4 v5 G");
  assert.deepEqual(result.integrationAnchors, [4, 4, 4]);
  const last = result.lanes[4];
  result.integrationRows.forEach((r, i) => assert.equal(r, last.startRow + last.rowCount + 1 + i));
});

test("old integration anchors at the last implementor validated before it", () => {
  const { result } = layoutOf("I1 I2 I3 v1 v2 G v3 G");
  assert.deepEqual(result.integrationAnchors, [1, 2]);
  assert.ok(result.integrationRows[0] < result.lanes[2].startRow);
  assert.ok(result.integrationRows[1] > result.lanes[2].startRow);
});

test("an integration with no manifest and no earlier validator stays at the bottom", () => {
  const { result } = layoutOf("I1 I2 G v1 v2");
  assert.deepEqual(result.integrationAnchors, [null]);
  assert.deepEqual(laneRows(result), [[0, 1], [2, 1]]);
  assert.equal(result.integrationStartRow, 4);
  assert.deepEqual(result.integrationRows, [4]);
  assert.equal(result.totalRows, 5);
});

test("placed integrations come first, unplaced ones last, orphans between", () => {
  const { workers } = layoutOf("I1 G v1 G");
  workers.push({ id: "orph", role: "validator", validates: "gone" });
  const r = pipelineUiModule.buildGraphLanes(workers);
  assert.deepEqual(r.integrations.map((g) => g.id), ["G3", "G1"]);
  assert.deepEqual(r.integrationAnchors, [0, null]);
  assert.deepEqual(r.integrationRows, [2, 6]);
  assert.equal(r.orphanStartRow, 4);
  assert.equal(r.integrationStartRow, 6);
  assert.equal(r.totalRows, 7);
});

test("hideFailed keeps the inference from hidden validators and gives no row to a hidden integration", () => {
  const workers = [{ id: "I1" }, { id: "I2" },
    { id: "va", role: "validator", validates: "I1" }, { id: "vb", role: "validator", validates: "I2", status: "failed" },
    { id: "G", role: "validator", kind: "integration" },
    { id: "Gbad", role: "validator", kind: "integration", status: "failed" }];
  const shown = pipelineUiModule.buildGraphLanes(workers, false);
  assert.deepEqual(shown.integrationAnchors, [1, 1]);
  const hidden = pipelineUiModule.buildGraphLanes(workers, true);
  assert.deepEqual(hidden.integrations.map((g) => g.id), ["G"]);
  assert.deepEqual(hidden.integrationAnchors, [1]);
  assert.deepEqual(laneRows(hidden), [[0, 1], [2, 1]]);
  assert.deepEqual(hidden.integrationRows, [4]);
});

test("real line shape: 5 implementors then vvvvvGvvGvvvGvGGGGvvG gives ordered rows each after its lane", () => {
  const impls = [1, 2, 3, 4, 5].map((n) => ({ id: "I" + n }));
  const vOrder = [1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 5, 1, 2, 3, 4, 5];
  const pattern = "vvvvvGvvGvvvGvGGGGvvG";
  let vi = 0, gi = 0;
  const rest = [...pattern].map((c) => c === "v"
    ? { id: "v" + vi, role: "validator", validates: "I" + vOrder[vi++] }
    : { id: "G" + gi++, role: "validator", kind: "integration" });
  const r = pipelineUiModule.buildGraphLanes([...impls, ...rest]);
  assert.equal(r.integrations.length, 8);
  for (let i = 1; i < r.integrationRows.length; i++) assert.ok(r.integrationRows[i] > r.integrationRows[i - 1]);
  r.integrations.forEach((g, i) => {
    const a = r.integrationAnchors[i];
    assert.notEqual(a, null);
    assert.ok(r.integrationRows[i] >= r.lanes[a].startRow + r.lanes[a].rowCount);
    for (const lane of r.lanes) {
      assert.ok(r.integrationRows[i] < lane.startRow || r.integrationRows[i] >= lane.startRow + lane.rowCount);
    }
  });
  assert.equal(r.integrationAnchors[0], 4);
});

test("dashboard state and workers list: an integration carries merged, others do not", async () => {
  const { startDashboardFixture } = require("./fixtures/dashboard-browser");
  const fx = await startDashboardFixture();
  try {
    const line = require("../server").lines.get(fx.lineId);
    const base = { role: "validator", status: "completed", transcript: [] };
    line.workers.set("i1", { id: "i1", name: "api", role: "implementor", status: "completed", transcript: [] });
    line.workers.set("i2", { id: "i2", name: "ui", role: "implementor", status: "completed", transcript: [] });
    line.workers.set("g1", { ...base, id: "g1", name: "integration-validator", kind: "integration",
      integration: { repos: [{ name: "r", branches: [{ workerId: "i1" }, { workerId: "i2" }, { workerId: "i1" }] }] } });
    line.workers.set("g0", { ...base, id: "g0", name: "old-integration", kind: "integration" });
    const byId = (list) => Object.fromEntries(list.map((w) => [w.id, w]));
    const state = byId(fx.controls.state().workers);
    assert.deepEqual(state.g1.merged, ["i1", "i2"]);
    assert.deepEqual(state.g0.merged, []);
    assert.equal("merged" in state.i1, false);
    assert.equal("integration" in state.g1, false);
    const res = await fetch(fx.url + "/api/protocol/lines/" + fx.lineId + "/workers");
    const listed = byId((await res.json()).workers);
    assert.deepEqual(listed.g1.merged, ["i1", "i2"]);
  } finally { await fx.close(); }
});
