"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const ins = require("../web/pipeline-inspector");

const model = () => ({
  name: "p", description: null, start: "a", defaults: {},
  nodes: [{ id: "a", type: "planner" }, { id: "b", type: "implementor", model: "m", checks: ["a"] }, { id: "c", type: "validator", after: ["a", "b"] }],
  edges: [{ from: "a", to: "b", interactions: ["start"] }, { from: "b", to: "c", interactions: ["accept"] }],
  extra: {},
});

test("renameNode changes nodes, edges, start, checks and after", () => {
  const next = ins.renameNode(model(), "a", "plan");
  assert.deepEqual(next.nodes.map((n) => n.id), ["plan", "b", "c"]);
  assert.equal(next.start, "plan");
  assert.equal(next.edges[0].from, "plan");
  assert.deepEqual(next.nodes[1].checks, ["plan"]);
  assert.deepEqual(next.nodes[2].after, ["plan", "b"]);
  assert.equal(model().start, "a", "the input stays");
});

test("idProblem refuses a bad id and a taken id", () => {
  assert.match(ins.idProblem(model(), "a", "Bad Id", "^[a-z]+$"), /must match/);
  assert.match(ins.idProblem(model(), "a", "b", "^[a-z]+$"), /taken/);
  assert.equal(ins.idProblem(model(), "a", "a", "^[a-z]+$"), "");
  assert.equal(ins.idProblem(model(), "a", "plan", "^[a-z]+$"), "");
});

test("setNodeKey sets a key and an empty value removes it", () => {
  let m = ins.setNodeKey(model(), "a", "effort", "high");
  assert.equal(m.nodes[0].effort, "high");
  for (const empty of [undefined, "", []]) {
    m = ins.setNodeKey(ins.setNodeKey(model(), "b", "checks", ["a"]), "b", "checks", empty);
    assert.equal("checks" in m.nodes[1], false);
  }
  assert.equal("model" in ins.setNodeKey(model(), "b", "model", "").nodes[1], false);
});

test("setPipelineKey sets description, start and defaults.prompt", () => {
  let m = ins.setPipelineKey(model(), "description", "text");
  assert.equal(m.description, "text");
  assert.equal(ins.setPipelineKey(m, "description", "").description, null);
  assert.equal(ins.setPipelineKey(model(), "start", "b").start, "b");
  m = ins.setPipelineKey(model(), "defaults.prompt", { file: "p.md" });
  assert.deepEqual(m.defaults, { prompt: { file: "p.md" } });
  assert.deepEqual(ins.setPipelineKey(m, "defaults.prompt", undefined).defaults, {});
});

test("rowsFromFields and fieldsFromRows round trip", () => {
  const fields = { goal: { description: "The goal", type: "string", maxLength: 50 },
    kind: { description: "Kind", type: "enum", values: ["a", "b"], optional: true } };
  assert.deepEqual(ins.fieldsFromRows(ins.rowsFromFields(fields)), fields);
  assert.deepEqual(ins.rowsFromFields(undefined), []);
  assert.deepEqual(ins.fieldsFromRows([{ name: "x", description: "d", pattern: "" }]), { x: { description: "d" } });
});

test("promptValue gives nothing, a string or a file", () => {
  assert.equal(ins.promptValue("none", "x"), undefined);
  assert.equal(ins.promptValue("text", ""), undefined);
  assert.equal(ins.promptValue("text", "hi"), "hi");
  assert.deepEqual(ins.promptValue("file", "a/b.md"), { file: "a/b.md" });
  assert.equal(ins.promptMode({ file: "x" }), "file");
  assert.equal(ins.promptText({ file: "x" }), "x");
});

test("freeName and splitList", () => {
  assert.equal(ins.freeName("field", ["field", "field-2"]), "field-3");
  assert.deepEqual(ins.splitList(" a, b ,,c"), ["a", "b", "c"]);
});
