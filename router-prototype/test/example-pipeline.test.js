"use strict";

// The built-in example pipeline "example-choreographed": rules, layout, call fields, planner prompt and catalog.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolvePipelineDefinition } = require("../resolve-pipeline");
const { requiredFields } = require("../call-fields");
const { graphRelations } = require("../graph-relations");
const { stageOf } = require("../choreography");
const { loadBuiltinPipeline } = require("../line-graph");
const { protocolSection } = require("../prompt-builder");
const { catalog, resolve } = require("./choreo-fixtures");

const ROOT = path.join(__dirname, "..");
const DESCRIPTION = "Example: backend work goes to a validator and a script check in parallel, frontend work to a validator. " +
  "Rework runs on its own. A wait node collects the batch. Then integration runs once.";

// The same catalog as the router: built-in types, interactions and pipeline files.
function builtinCatalog() {
  const c = catalog("");
  c.pipelines = {};
  for (const f of fs.readdirSync(path.join(ROOT, "pipelines")).filter((x) => x.endsWith(".yaml"))) {
    c.pipelines[f.replace(/\.yaml$/, "")] = { file: path.join(ROOT, "pipelines", f), layer: "built-in" };
  }
  return c;
}
const graph = () => resolvePipelineDefinition("example-choreographed", builtinCatalog());

test("example-choreographed resolves with the built-in catalog and has no rule errors", () => {
  const r = graph();
  assert.equal(r.name, "example-choreographed");
  assert.equal(r.description, DESCRIPTION);
  assert.deepEqual(Object.keys(r.nodes), ["planner", "backend-impl", "frontend-impl", "backend-val",
    "backend-lint", "frontend-val", "batch", "integration"]);
  assert.equal(r.nodes["backend-lint"].scripts[0].run, 'git diff --check "$DUCK_BASE_COMMIT" HEAD');
});

test("example-choreographed has stable columns", () => {
  assert.deepEqual(graphRelations(graph()).columns, {
    planner: 0, "backend-impl": 1, "frontend-impl": 1, "backend-val": 2, "backend-lint": 2, "frontend-val": 2,
    batch: 3, integration: 4 });
});

test("stageOf lists the checkers of each implementor", () => {
  const r = graph();
  assert.deepEqual(stageOf(r, "backend-impl"), ["backend-val", "backend-lint"]);
  assert.deepEqual(stageOf(r, "frontend-impl"), ["frontend-val"]);
});

test("the start of a chain head and of the batch require the chain fields", () => {
  const r = graph();
  const need = (node) => Object.keys(requiredFields(r, "start", node)).sort();
  for (const node of ["backend-impl", "frontend-impl"]) {
    for (const field of ["task", "repo", "criteria"]) assert.ok(need(node).includes(field), `${node} needs ${field}`);
  }
  for (const field of ["members", "instructions"]) assert.ok(need("batch").includes(field), `batch needs ${field}`);
});

test("the planner prompt names both chains and the batch", () => {
  const r = loadBuiltinPipeline("example-choreographed", fs, ROOT);
  const text = protocolSection(r, r.start, "http://r", "l1");
  const chains = text.split("## Chains\n")[1];
  assert.ok(chains, "the Chains section exists");
  assert.match(chains, /After 'backend-impl' finishes, the router starts 'backend-val' and 'backend-lint' at the same time/);
  assert.match(chains, /After 'frontend-impl' finishes, the router starts 'frontend-val' with the fields of your start call\./);
  assert.match(chains, /Start 'batch' with the instance names of the tasks in 'members'\./);
});

test("the linear YAML snippet of the README loads and has no rule errors", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const section = readme.split("#### Reference example and walkthrough")[1];
  assert.ok(section, "the section exists");
  const snippet = /```yaml\n([\s\S]*?)```/.exec(section)[1];
  assert.match(snippet, /^name: linear$/m);
  // resolve() parses the text (parsePipeline), resolves it and runs checkPipeline; any rule error throws.
  const r = resolve(snippet);
  assert.equal(r.name, "linear");
  const edges = r.edges.map((e) => `${e.from}->${e.to}:${e.interactions.join(",")}`);
  for (const edge of ["impl->ci:handoff", "ci->impl:rework", "ci->val:handoff", "val->impl:rework"]) {
    assert.ok(edges.includes(edge), edge);
  }
});
