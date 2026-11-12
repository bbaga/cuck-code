"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { normalizeLine, graphView } = require("../line-graph");
const { resolveNodeSettings } = require("../pipeline-config");
const { integrationSelection } = require("../line-repos");

const stored = () => JSON.parse(fs.readFileSync(
  path.join(__dirname, "fixtures", "line-graph-before-script-checks.json"), "utf8"));

test("the stored graph has none of the new keys", () => {
  const text = JSON.stringify(stored());
  for (const key of ["after", "scripts", "failFast", "required", "checkout", "runner"]) {
    assert.equal(text.includes(`"${key}"`), false, key);
  }
});

test("a line with a graph from before script checks loads and is drawn", () => {
  const meta = { id: "l1", graph: stored(), nodeSettings: {}, workers: [] };
  const line = normalizeLine(meta, stored());
  const view = graphView(line.graph);
  assert.deepEqual(view.columns, {
    planner: 0, "backend-impl": 1, "frontend-impl": 1, "backend-val": 2, "frontend-val": 2, integration: 3,
  });
  assert.equal(view.nodes["backend-val"].runner, "agent");
  assert.deepEqual(view.nodes["backend-val"].after, []);
  assert.equal(view.nodes["backend-val"].scripts, undefined);
});

test("settings and the integration selection read missing keys as defaults", () => {
  const line = normalizeLine({ id: "l2", graph: stored(), nodeSettings: {}, workers: [] }, stored());
  for (const id of Object.keys(line.graph.nodes)) {
    const s = resolveNodeSettings(line, id, {});
    assert.notEqual(s.runner, "script", id);
  }
  const worker = { id: "w1", name: "api", role: "implementor", node: "backend-impl", status: "completed" };
  const { included, blockers } = integrationSelection([worker], line.graph);
  assert.equal(included.length, 0);
  assert.equal(blockers[0].reason, "awaiting-criteria");
});
