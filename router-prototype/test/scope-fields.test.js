const test = require("node:test");
const assert = require("node:assert/strict");
const { scopeFields, scopeSummary } = require("../scope-fields");

const impl = { id: "i1", name: "impl-one", role: "implementor", prompt: "Build X" };
const workers = new Map([["i1", impl]]);

test("scope summaries omit text and change revision when scope changes", () => {
  const summary = scopeSummary(impl, workers);
  assert.equal(Object.hasOwn(summary, "prompt"), false);
  assert.equal(Object.hasOwn(summary, "criteria"), false);
  assert.equal(summary.scopeRevision, scopeSummary({ ...impl }, workers).scopeRevision);
  assert.notEqual(summary.scopeRevision, scopeSummary({ ...impl, prompt: "New task" }, workers).scopeRevision);
  const validator = { role: "validator", validates: "i1", validationCriteria: "Check X" };
  assert.equal(scopeSummary(validator, workers).validatesName, "impl-one");
  assert.notEqual(scopeSummary(validator, workers).scopeRevision,
    scopeSummary({ ...validator, validationCriteria: "Check Y" }, workers).scopeRevision);
});

test("implementor gets its brief", () => {
  assert.deepEqual(scopeFields(impl, workers),
    { prompt: "Build X", criteria: null, validates: null, validatesName: null });
});

test("standard validator gets criteria and checked implementor", () => {
  const v = { id: "v1", role: "validator", kind: "standard", validates: "i1",
    validationCriteria: "1. Check X", prompt: "validator brief" };
  assert.deepEqual(scopeFields(v, workers),
    { prompt: null, criteria: "1. Check X", validates: "i1", validatesName: "impl-one" });
});

test("validator with a missing implementor has null name", () => {
  const v = { role: "validator", validates: "gone", validationCriteria: "c" };
  assert.equal(scopeFields(v, workers).validatesName, null);
  assert.equal(scopeFields(v).validates, "gone");
});

test("array and object criteria become text", () => {
  assert.equal(scopeFields({ role: "validator", validationCriteria: ["a", "b"] }).criteria,
    "1. a\n2. b");
  assert.equal(scopeFields({ role: "validator", validationCriteria: { k: "v" } }).criteria, "k: v");
});

test("integration validator gets its brief", () => {
  const v = { role: "validator", kind: "integration", validates: null, prompt: "Merge all" };
  assert.deepEqual(scopeFields(v, workers),
    { prompt: "Merge all", criteria: null, validates: null, validatesName: null });
});
