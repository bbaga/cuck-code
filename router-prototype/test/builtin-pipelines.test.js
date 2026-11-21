"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolvePipelineDefinition } = require("../resolve-pipeline");
const { requiredFields, checkCall } = require("../call-fields");
const { render, placeholders } = require("../template");
const { graphRelations } = require("../graph-relations");
const choreo = require("./choreo-fixtures");

const ROOT = path.join(__dirname, "..");
const readFile = (p) => fs.readFileSync(p, "utf8");
const dirs = (sub) => fs.readdirSync(path.join(ROOT, sub), { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name);

function catalog() {
  const types = {};
  for (const n of dirs("node-types")) types[n] = { folder: path.join(ROOT, "node-types", n), layer: "built-in" };
  const interactions = {};
  for (const n of dirs("interactions")) {
    interactions[n] = { folder: path.join(ROOT, "interactions", n), layer: "built-in", builtIn: true };
  }
  const pipelines = {};
  for (const f of fs.readdirSync(path.join(ROOT, "pipelines")).filter((x) => x.endsWith(".yaml"))) {
    pipelines[f.replace(/\.yaml$/, "")] = { file: path.join(ROOT, "pipelines", f), layer: "built-in" };
  }
  return { readFile, types, interactions, pipelines };
}

const edgeKey = (e) => `${e.from}->${e.to}:${e.interactions.join(",")}`;

test("the built-in interactions exist", () => {
  assert.deepEqual(dirs("interactions").sort(), ["accept", "arrive", "feedback", "handoff", "report", "rework", "start"]);
});

test("the built-in node types include the wait type", () => {
  assert.ok(dirs("node-types").includes("wait"));
});

test("the choreography interactions load with the contract values", () => {
  const r = choreo.resolve(choreo.CHAIN);
  const { report, handoff, rework, arrive } = r.interactions;
  assert.equal(report.fallback, true);
  assert.deepEqual([handoff.effect, handoff.trigger, handoff.target, handoff.when, handoff.fallback],
    ["create", "complete", "new", ["done", "pass"], false]);
  assert.deepEqual([rework.effect, rework.target, rework.when], ["deliver", "source", ["reject", "missing"]]);
  assert.deepEqual([arrive.effect, arrive.target, arrive.when], ["arrive", "waiter", ["done", "pass"]]);
  assert.match(rework.body, /^REWORK REQUEST - checker '\{\{from\.name\}\}' \(node \{\{from\.node\}\}\) rejected your latest run\./);
  assert.equal(handoff.body.trim(), "");
  assert.equal(arrive.body.trim(), "");
  assert.equal(r.types.wait.runner, "wait");
});

test("the report interaction body is unchanged: default prompts keep their text", () => {
  const body = fs.readFileSync(path.join(ROOT, "interactions", "report", "INTERACTION.md"), "utf8");
  assert.match(body, /target: starter\nfallback: true\n---\n\{\{#outcome\.done\}\}IMPLEMENTOR REPORT/);
});

test("default resolves with no errors", () => {
  const r = resolvePipelineDefinition("default", catalog());
  assert.equal(r.name, "default");
  assert.equal(r.start, "planner");
  assert.deepEqual(Object.keys(r.nodes).sort(),
    ["backend-impl", "backend-val", "frontend-impl", "frontend-val", "integration", "planner"]);
  assert.deepEqual(r.nodes["backend-val"].checks, ["backend-impl"]);
  assert.deepEqual(r.nodes["frontend-val"].checks, ["frontend-impl"]);
  assert.equal(r.nodes.integration.type, "integration-validator");
  const edges = r.edges.map(edgeKey).sort();
  for (const impl of ["backend-impl", "frontend-impl"]) {
    assert.ok(edges.includes(`planner->${impl}:start,feedback,accept`), impl);
    assert.ok(edges.includes(`${impl}->planner:report`), impl);
  }
  for (const val of ["backend-val", "frontend-val"]) {
    assert.ok(edges.includes(`planner->${val}:start`), val);
    assert.ok(edges.includes(`${val}->planner:report`), val);
  }
  assert.ok(edges.includes("planner->integration:start"));
  assert.ok(edges.includes("integration->planner:report"));
  assert.equal(edges.length, 10);
  assert.deepEqual(Object.keys(r.interactions).sort(), ["accept", "feedback", "report", "start"]);
});

test("minimal resolves with no errors", () => {
  const r = resolvePipelineDefinition("minimal", catalog());
  assert.equal(r.name, "minimal");
  assert.deepEqual(Object.keys(r.nodes).sort(), ["impl", "integration", "planner", "val"]);
  assert.deepEqual(r.nodes.val.checks, ["impl"]);
  assert.deepEqual(r.edges.map(edgeKey).sort(), [
    "impl->planner:report", "integration->planner:report", "planner->impl:start,feedback,accept",
    "planner->integration:start", "planner->val:start", "val->planner:report",
  ]);
});

test("calls on the default pipeline need the documented fields", () => {
  const r = resolvePipelineDefinition("default", catalog());
  const names = (iName, node) => Object.keys(requiredFields(r, iName, node)).sort();
  const req = (iName, node) => Object.entries(requiredFields(r, iName, node))
    .filter(([, v]) => v.decl.optional !== true).map(([k]) => k).sort();
  assert.deepEqual(req("start", "backend-impl"), ["repo", "task"]);
  assert.deepEqual(req("start", "backend-val"), ["criteria", "source"]);
  assert.deepEqual(req("feedback", "backend-impl"), ["instance", "instructions"]);
  assert.deepEqual(Object.keys(r.interactions.accept.fields).sort(), ["instance", "reason"]);
  assert.ok(req("accept", "backend-impl").includes("instance"));
  assert.ok(names("start", "backend-impl").includes("task"));
  assert.equal(requiredFields(r, "start", "backend-val").source.decl.node, "backend-impl");

  const ok = checkCall(r, "feedback", "backend-impl", { instance: "abc", instructions: "Fix it." });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const bad = checkCall(r, "feedback", "backend-impl", { instance: "abc" });
  assert.deepEqual(bad.missing.map((m) => m.field), ["instructions"]);
});

test("the report template uses router variables only and renders the old sentences", () => {
  const r = resolvePipelineDefinition("default", catalog());
  const report = r.interactions.report;
  assert.equal(report.trigger, "complete");
  assert.equal(report.target, "starter");
  assert.deepEqual(report.fields, {});
  assert.doesNotThrow(() => placeholders(report.body));

  const base = { from: { node: "backend-impl", name: "api", id: "w1", harness: "vibe", session: "s1",
    branch: "feat/x", type: {} }, report: "All done.", source: { name: "api", id: "w1", harness: "vibe", session: "s1" } };
  const as = (kind, outcome, extra = {}) => render(report.body, {
    ...base, from: { ...base.from, type: { [kind]: true }, ...(extra.from || {}) },
    outcome: { [outcome]: true }, source: base.source, pipeline: { has: { checker: true } },
  });

  assert.equal(as("implementor", "done"),
    "IMPLEMENTOR REPORT - 'api' (workerId w1, vibe session s1, branch feat/x) finished.\n\n" +
    "REPORT BODY (complete):\nAll done.\n\nNow give the acceptance criteria for the validation of this work.\n" +
    "Start a validator with the criteria. If the work needs no validation, accept it.");
  const val = as("validator", "pass");
  assert.match(val, /^VALIDATION REPORT - validator 'api' checked the work of implementor 'api' \(workerId w1, vibe session s1, branch feat\/x\)\./);
  assert.match(val, /\n\nFINAL VERDICT: PASS\.\n\nDecide: accept the work, send feedback to the original implementor \(instance w1\), or start a new implementor with a corrected task\./);
  assert.match(as("validator", "reject"), /FINAL VERDICT: FAIL\./);
  assert.match(as("validator", "missing"), /DIAGNOSTIC: no explicit final VERDICT/);
  assert.match(as("integration", "pass"), /^INTEGRATION REPORT - integration validator 'api' finished\./);
  assert.match(as("implementor", "timeout"), /^WORKER TIMEOUT - worker hit the run time limit[\s\S]*RUN OUTPUT \(complete\):\nAll done\.$/);
  const failed = as("implementor", "failed", { from: { error: "boom" } });
  assert.match(failed, /^WORKER FAILURE - 'api' \(workerId w1, session s1\): vibe failed/);
  assert.match(failed, /\n\nFAILURE DETAIL:\nboom$/);
  assert.match(as("validator", "stopped"), /^VALIDATOR STOPPED - validator 'api' \(checking implementor 'api', workerId w1\) was stopped\./);
  assert.match(as("validator", "timeout"), /^VALIDATOR TIMEOUT/);
  assert.match(as("integration", "failed"), /^INTEGRATION STOPPED\/FAILED/);
  assert.match(as("integration", "timeout"), /^INTEGRATION TIMEOUT - integration validator 'api' hit the run time limit\. The merged work is on branch feat\/x\./);
});

// A node of a base type (implementor, validator) has an incomplete prompt: no task, no criteria.
// Every node that `start` can create in a built-in pipeline must take the field that carries its work.
test("every node a built-in pipeline can start takes the field of its work", () => {
  const WORK_FIELD = { "own-worktree": "task", source: "criteria", integration: "instructions" };
  for (const name of ["default", "minimal"]) {
    const r = resolvePipelineDefinition(name, catalog());
    let checked = 0;
    for (const edge of r.edges) {
      if (!edge.interactions.includes("start")) continue;
      const node = r.nodes[edge.to];
      const workspace = r.types[node.type].workspace;
      const field = WORK_FIELD[workspace];
      if (!field) continue;
      const need = Object.keys(requiredFields(r, "start", edge.to));
      assert.ok(need.includes(field), `${name}: start on '${edge.to}' (${node.type}) must take '${field}', takes ${JSON.stringify(need)}`);
      checked++;
    }
    assert.ok(checked >= 3, `${name}: the planner can start at least an implementor, a validator and the integration node`);
  }
});

// The layout of the built-in pipelines under the declared-relation rules.
const LAYOUT = {
  default: {
    columns: { planner: 0, "backend-impl": 1, "frontend-impl": 1, "backend-val": 2, "frontend-val": 2, integration: 3 },
    rows: { planner: 0, "backend-impl": 0, "frontend-impl": 1, "backend-val": 0, "frontend-val": 1, integration: 0 },
  },
  minimal: {
    columns: { planner: 0, impl: 1, val: 2, integration: 3 },
    rows: { planner: 0, impl: 0, val: 0, integration: 0 },
  },
};

for (const name of Object.keys(LAYOUT)) {
  test(`${name} has the documented columns and rows and no new keys`, () => {
    const r = resolvePipelineDefinition(name, catalog());
    const g = graphRelations(r);
    assert.deepEqual(g.columns, LAYOUT[name].columns);
    assert.deepEqual(g.rows, LAYOUT[name].rows);
    assert.equal(g.cycle, null);
    for (const [id, node] of Object.entries(r.nodes)) {
      for (const key of ["after", "required", "scripts"]) {
        assert.equal(Object.prototype.hasOwnProperty.call(node, key), false, `${name}.${id} has ${key}`);
      }
    }
    const kinds = [...new Set(g.relations.map((x) => x.kind))].sort();
    assert.deepEqual(kinds, ["accepted-work", "checks", "interaction"]);
  });
}

test("planner-only, implement-only and choreographed resolve and follow the rules", () => {
  for (const [name, nodes] of [["planner-only", ["planner"]], ["implement-only", ["planner", "impl"]],
    ["choreographed", ["planner", "impl", "val", "batch", "integration"]],
    ["example-choreographed", ["planner", "backend-impl", "frontend-impl", "backend-val", "backend-lint",
      "frontend-val", "batch", "integration"]]]) {
    const r = resolvePipelineDefinition(name, catalog());
    assert.equal(r.name, name);
    assert.deepEqual(Object.keys(r.nodes), nodes);
    assert.equal(r.start, "planner");
  }
  assert.deepEqual(resolvePipelineDefinition("planner-only", catalog()).edges, []);
});
