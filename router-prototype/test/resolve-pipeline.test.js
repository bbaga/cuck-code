"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolvePipelineDefinition, PipelineError } = require("../resolve-pipeline");
const { requiredFields, checkCall } = require("../call-fields");

const NODE_TYPES = path.join(__dirname, "..", "node-types");
const readDisk = (p) => fs.readFileSync(p, "utf8");

const inter = (name, effect, trigger, target, fields = {}, body = "") =>
  ({ name, description: name, effect, trigger, target, fields, body, bodyLine: 1 });
const INTERACTIONS = {
  start: { definition: inter("start", "create", "request", "new"), layer: "built-in" },
  feedback: {
    definition: inter("feedback", "deliver", "request", "chosen",
      { instructions: { description: "Follow-up instructions.", type: "text" } }, "{{instructions}}"),
    layer: "built-in",
  },
  report: { definition: inter("report", "deliver", "complete", "starter", {}, "{{report}}"), layer: "built-in" },
};

const builtInTypes = (...names) => Object.fromEntries(
  names.map((n) => [n, { folder: path.join(NODE_TYPES, n), layer: "built-in" }]));
const ALL_TYPES = builtInTypes("planner", "implementor", "backend-implementor", "validator", "backend-validator");

const GOOD = `
name: backend-flow
description: Backend work and a validator.
start: planner
nodes:
  planner: { type: planner }
  A: { type: backend-implementor, harness: vibe, model: m1 }
  B: { type: backend-validator, checks: [A] }
edges:
  - planner -> A: start, feedback
  - planner -> B: start
  - "[A, B] -> planner: report"
`;

function catalog(pipelineText, extra = {}) {
  return {
    readFile: readDisk,
    types: ALL_TYPES,
    interactions: INTERACTIONS,
    pipelines: { p: { text: pipelineText, layer: "test" } },
    ...extra,
  };
}

test("resolves a pipeline with built-in node types", () => {
  const r = resolvePipelineDefinition("p", catalog(GOOD));
  assert.equal(r.name, "backend-flow");
  assert.equal(r.layer, "test");
  assert.equal(r.start, "planner");
  assert.deepEqual(Object.keys(r.nodes), ["planner", "A", "B"]);
  assert.deepEqual(r.nodes.A.settings, { harness: "vibe", model: "m1" });
  assert.deepEqual(r.nodes.B.checks, ["A"]);
  assert.deepEqual(Object.keys(r.types).sort(), ["backend-implementor", "backend-validator", "planner"]);
  assert.deepEqual(Object.keys(r.interactions).sort(), ["feedback", "report", "start"]);
  assert.equal(r.edges.length, 4);
  // Merged persona type: parent body first, then the child body.
  const t = r.types["backend-implementor"];
  assert.ok(t.body.indexOf("implementor worker") < t.body.indexOf("Your persona: backend"));
  assert.equal(t.workspace, "own-worktree");
  assert.ok("task" in t.fields);
});

test("the result survives a JSON round trip", () => {
  const r = resolvePipelineDefinition("p", catalog(GOOD));
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test("the result works with call-fields", () => {
  const r = resolvePipelineDefinition("p", catalog(GOOD));
  const a = requiredFields(r, "start", "A");
  assert.ok("task" in a && "repo" in a);
  const b = checkCall(r, "start", "B", { criteria: "1. Works.", source: "i-1" });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(checkCall(r, "feedback", "A", { instance: "i-1", instructions: "x" }).ok, true);
});

test("node and defaults prompts are kept and checked", () => {
  const yaml = `
name: x
start: planner
defaults:
  prompt: "Product {{product}}"
nodes:
  planner: { type: planner, fields: { product: { description: Product, type: string } } }
  A:
    type: backend-implementor
    prompt: "Risk {{riskLevel}}"
    fields:
      product: { description: Product, type: string }
      riskLevel: { description: Risk, type: string }
edges:
  - planner -> A: start
  - A -> planner: report
`;
  const r = resolvePipelineDefinition("p", catalog(yaml));
  assert.equal(r.defaults.prompt, "Product {{product}}");
  assert.equal(r.nodes.A.prompt, "Risk {{riskLevel}}");
  const f = requiredFields(r, "start", "A");
  assert.equal(f.product.requiredBy, "pipeline defaults");
  assert.equal(f.riskLevel.requiredBy, "pipeline node A");
});

test("loads real files from disk, including a prompt file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-pipeline-"));
  try {
    fs.mkdirSync(path.join(dir, "pipelines", "prompts"), { recursive: true });
    fs.mkdirSync(path.join(dir, "interactions", "ping"), { recursive: true });
    fs.writeFileSync(path.join(dir, "pipelines", "prompts", "extra.md"), "Extra rule for {{repo.name}}.\n");
    fs.writeFileSync(path.join(dir, "interactions", "ping", "INTERACTION.md"),
      "---\nname: ping\ndescription: Ping an instance.\neffect: deliver\ntrigger: request\ntarget: chosen\n---\nPing.\n");
    fs.writeFileSync(path.join(dir, "pipelines", "disk.yaml"), `name: disk
start: planner
nodes:
  planner: { type: planner }
  A: { type: implementor, prompt: { file: prompts/extra.md } }
edges:
  - planner -> A: start, ping
  - A -> planner: report
`);
  const cat = {
      readFile: readDisk,
      types: builtInTypes("planner", "implementor"),
      interactions: {
        start: INTERACTIONS.start,
        report: INTERACTIONS.report,
        ping: { folder: path.join(dir, "interactions", "ping"), layer: "user" },
      },
      pipelines: { disk: { file: path.join(dir, "pipelines", "disk.yaml"), layer: "user" } },
    };
    const r = resolvePipelineDefinition("disk", cat);
    assert.equal(r.nodes.A.prompt, "Extra rule for {{repo.name}}.\n");
    assert.equal(r.interactions.ping.body, "Ping.\n");
    assert.equal(r.interactions.ping.layer, "user");
    assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a node type given as text loads", () => {
  const cat = catalog(`name: t
start: planner
nodes:
  planner: { type: lead }
edges: []
`, {
    types: {
      lead: {
        layer: "test",
        text: "---\nname: lead\nsession: resume\nworkspace: coordinator\noutcome: none\ncoordinator: true\n---\nLead.\n",
      },
    },
  });
  const r = resolvePipelineDefinition("p", cat);
  assert.equal(r.types.lead.body, "Lead.\n");
  assert.equal(r.types.lead.layer, "test");
});

test("only the types a pipeline uses are loaded", () => {
  const types = { ...ALL_TYPES, broken: { text: "no frontmatter", layer: "test" } };
  assert.doesNotThrow(() => resolvePipelineDefinition("p", catalog(GOOD, { types })));
});

test("rule errors come as one full list", () => {
  const text = `name: bad
start: planner
nodes:
  planner: { type: planner }
  A: { type: nope }
  B: { type: implementor }
edges:
  - planner -> B: start, ghost
`;
  assert.throws(() => resolvePipelineDefinition("p", catalog(text)), (err) => {
    assert.ok(err instanceof PipelineError);
    assert.equal(err.name, "PipelineError");
    const rules = new Set(err.errors.map((e) => e.rule));
    assert.ok(rules.has("R8"));
    assert.ok(rules.has("R2"));
    assert.ok(err.errors.length >= 3);
    assert.match(err.message, /unknown node type 'nope'/);
    assert.match(err.message, /unknown interaction 'ghost'/);
    return true;
  });
});

test("a field declared in two different ways is a pipeline error", () => {
  const text = `name: c
start: planner
nodes:
  planner: { type: planner }
  A:
    type: backend-implementor
    prompt: "{{task}}"
    fields:
      task: { description: Other, type: string }
edges:
  - planner -> A: start
  - A -> planner: report
`;
  assert.throws(() => resolvePipelineDefinition("p", catalog(text)), (err) => {
    assert.ok(err instanceof PipelineError);
    assert.ok(err.errors.some((e) => e.rule === "CALL" && /task/.test(e.message)));
    return true;
  });
});

test("load failures are reported", () => {
  const types = {
    ...ALL_TYPES,
    implementor: { text: "---\nname: implementor\nextends: ghost-parent\n---\nBody\n", layer: "test" },
  };
  assert.throws(() => resolvePipelineDefinition("p", catalog(GOOD, { types })), (err) => {
    assert.ok(err instanceof PipelineError);
    assert.ok(err.errors.some((e) => e.rule === "LOAD"));
    return true;
  });
  assert.throws(() => resolvePipelineDefinition("nope", catalog(GOOD)), /unknown pipeline 'nope'/);
  assert.throws(() => resolvePipelineDefinition("p", catalog("name: [")), PipelineError);
});
