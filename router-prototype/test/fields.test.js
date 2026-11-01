"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  ROUTER_VARIABLES,
  isRouterVariable,
  checkDeclaration,
  checkValues,
  checkOptionalUse,
} = require("../fields");

const ok = (extra) => ({ description: "A field.", type: "string", ...extra });

test("ROUTER_VARIABLES lists the router patterns", () => {
  for (const p of ["line.*", "node.*", "instance.*", "from.*", "repo.url", "repo.name", "router.url", "source.name", "source.report", "report", "outcome"]) {
    assert.ok(ROUTER_VARIABLES.includes(p), p);
  }
});

test("isRouterVariable matches wildcard and exact names only", () => {
  for (const n of ["line.id", "node.type", "instance.name", "from.node", "repo.url", "repo.name", "router.url", "source.name", "source.report", "report", "outcome"]) {
    assert.equal(isRouterVariable(n), true, n);
  }
  for (const n of ["line", "line.", "task", "repo", "repo.other", "source", "reports", "router", "lines.x", "outcomes", "", 5, null]) {
    assert.equal(isRouterVariable(n), false, String(n));
  }
});

test("checkDeclaration accepts valid declarations of every type", () => {
  assert.deepEqual(checkDeclaration("a", ok()), []);
  assert.deepEqual(checkDeclaration("a", ok({ maxLength: 10, pattern: "^[A-Z]+$", optional: true })), []);
  assert.deepEqual(checkDeclaration("a", ok({ type: "text", maxLength: 8000 })), []);
  assert.deepEqual(checkDeclaration("a", ok({ type: "enum", values: ["x", "y"] })), []);
  assert.deepEqual(checkDeclaration("a", ok({ type: "instance", node: "B" })), []);
  assert.deepEqual(checkDeclaration("a", ok({ type: "instance" })), []);
  assert.deepEqual(checkDeclaration("a", ok({ type: "commit" })), []);
  assert.deepEqual(checkDeclaration("a", ok({ type: "repo" })), []);
});

test("checkDeclaration requires a description of 1 to 300 characters", () => {
  assert.equal(checkDeclaration("a", { type: "string" }).length, 1);
  assert.equal(checkDeclaration("a", ok({ description: "" })).length, 1);
  assert.equal(checkDeclaration("a", ok({ description: 5 })).length, 1);
  assert.deepEqual(checkDeclaration("a", ok({ description: "x".repeat(300) })), []);
  assert.equal(checkDeclaration("a", ok({ description: "x".repeat(301) })).length, 1);
});

test("checkDeclaration checks type", () => {
  assert.equal(checkDeclaration("a", { description: "d" }).length, 1);
  assert.equal(checkDeclaration("a", ok({ type: "number" })).length, 1);
});

test("checkDeclaration checks string options", () => {
  assert.equal(checkDeclaration("a", ok({ maxLength: 0 })).length, 1);
  assert.equal(checkDeclaration("a", ok({ maxLength: "5" })).length, 1);
  assert.equal(checkDeclaration("a", ok({ pattern: "(" })).length, 1);
  assert.equal(checkDeclaration("a", ok({ pattern: 5 })).length, 1);
  assert.equal(checkDeclaration("a", ok({ values: ["x"] })).length, 1);
});

test("checkDeclaration checks text options", () => {
  assert.deepEqual(checkDeclaration("a", ok({ type: "text", maxLength: 5 })), []);
  assert.equal(checkDeclaration("a", ok({ type: "text", maxLength: -1 })).length, 1);
  assert.equal(checkDeclaration("a", ok({ type: "text", pattern: "x" })).length, 1);
});

test("checkDeclaration checks enum values", () => {
  assert.equal(checkDeclaration("a", ok({ type: "enum" })).length, 1);
  assert.equal(checkDeclaration("a", ok({ type: "enum", values: [] })).length, 1);
  assert.equal(checkDeclaration("a", ok({ type: "enum", values: [1] })).length, 1);
  assert.equal(checkDeclaration("a", ok({ type: "enum", values: "x" })).length, 1);
});

test("checkDeclaration checks the instance node option", () => {
  assert.equal(checkDeclaration("a", ok({ type: "instance", node: "" })).length, 1);
  assert.equal(checkDeclaration("a", ok({ type: "instance", node: 3 })).length, 1);
  assert.equal(checkDeclaration("a", ok({ type: "repo", node: "B" })).length, 1);
});

test("checkDeclaration checks optional", () => {
  assert.deepEqual(checkDeclaration("a", ok({ optional: true })), []);
  assert.equal(checkDeclaration("a", ok({ optional: false })).length, 1);
  assert.equal(checkDeclaration("a", ok({ optional: "yes" })).length, 1);
});

test("checkDeclaration rejects unknown keys", () => {
  const errors = checkDeclaration("a", ok({ colour: "red" }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /colour/);
});

test("checkDeclaration rejects router variable names and non-objects", () => {
  assert.equal(checkDeclaration("line.id", ok()).length, 1);
  assert.equal(checkDeclaration("report", ok()).length, 1);
  assert.equal(checkDeclaration("a", null).length, 1);
  assert.equal(checkDeclaration("a", []).length, 1);
  assert.equal(checkDeclaration("a", "text").length, 1);
});

const declared = {
  task: { decl: { description: "The task.", type: "text" }, requiredBy: "interaction start" },
  ticket: { decl: { description: "Ticket.", type: "string", pattern: "^[A-Z]+-[0-9]+$", optional: true }, requiredBy: "node type x" },
  level: { decl: { description: "Level.", type: "enum", values: ["low", "high"] }, requiredBy: "node type x" },
  source: { decl: { description: "Source.", type: "instance" }, requiredBy: "workspace: source" },
};

test("checkValues passes a complete body", () => {
  const r = checkValues(declared, { task: "do", level: "low", source: "i1", ticket: "AB-1" });
  assert.deepEqual(r, { missing: [], invalid: [], unexpected: [] });
});

test("checkValues reports missing and blank required fields with description and requiredBy", () => {
  const r = checkValues(declared, { task: "   ", level: "low" });
  assert.deepEqual(r.missing, [
    { field: "task", description: "The task.", requiredBy: "interaction start" },
    { field: "source", description: "Source.", requiredBy: "workspace: source" },
  ]);
  assert.deepEqual(r.invalid, []);
});

test("checkValues does not require optional fields", () => {
  const r = checkValues(declared, { task: "a", level: "high", source: "i" });
  assert.deepEqual(r.missing, []);
});

test("checkValues reports invalid values", () => {
  const r = checkValues(declared, { task: "a".repeat(20001), level: "mid", source: "i", ticket: "bad" });
  assert.deepEqual(r.invalid.map((x) => x.field).sort(), ["level", "task", "ticket"]);
  assert.match(r.invalid.find((x) => x.field === "task").reason, /longer than 20000 characters/);
  assert.deepEqual(r.missing, []);
});

test("checkValues rejects wrong types, long strings and newlines in strings", () => {
  const d = { s: { decl: { description: "d", type: "string" }, requiredBy: "r" } };
  assert.equal(checkValues(d, { s: 5 }).invalid.length, 1);
  assert.equal(checkValues(d, { s: "x".repeat(201) }).invalid.length, 1);
  assert.equal(checkValues(d, { s: "x".repeat(200) }).invalid.length, 0);
  assert.equal(checkValues(d, { s: "a\nb" }).invalid.length, 1);
  const t = { s: { decl: { description: "d", type: "text", maxLength: 5 }, requiredBy: "r" } };
  assert.equal(checkValues(t, { s: "a\nb" }).invalid.length, 0);
  assert.equal(checkValues(t, { s: "abcdef" }).invalid.length, 1);
});

test("checkValues ignores a blank optional field and checks a present one", () => {
  assert.deepEqual(checkValues(declared, { task: "a", level: "low", source: "i", ticket: "  " }).invalid, []);
  assert.equal(checkValues(declared, { task: "a", level: "low", source: "i", ticket: 5 }).invalid.length, 1);
});

test("checkValues reports unexpected names and router variables", () => {
  const r = checkValues(declared, { task: "a", level: "low", source: "i", persona: "x", report: "y" });
  assert.deepEqual(r.unexpected, ["persona", "report"]);
});

test("checkValues only checks instance, repo and commit as non-empty strings", () => {
  const d = {
    i: { decl: { description: "d", type: "instance" }, requiredBy: "r" },
    r: { decl: { description: "d", type: "repo" }, requiredBy: "r" },
    c: { decl: { description: "d", type: "commit" }, requiredBy: "r" },
  };
  assert.deepEqual(checkValues(d, { i: "x", r: "y", c: "z" }), { missing: [], invalid: [], unexpected: [] });
  assert.equal(checkValues(d, { i: 1, r: ["a"], c: {} }).invalid.length, 3);
  assert.equal(checkValues(d, { i: "", r: "y", c: "z" }).missing.length, 1);
});

test("checkOptionalUse allows an optional field only inside its own section", () => {
  const decl = { description: "d", type: "string", optional: true };
  assert.equal(checkOptionalUse("ticket", decl, ["ticket"]), null);
  assert.equal(checkOptionalUse("ticket", decl, ["other", "ticket"]), null);
  assert.equal(typeof checkOptionalUse("ticket", decl, []), "string");
  assert.equal(typeof checkOptionalUse("ticket", decl, ["other"]), "string");
  assert.equal(typeof checkOptionalUse("ticket", decl, undefined), "string");
  const req = { description: "d", type: "string" };
  assert.equal(checkOptionalUse("task", req, []), null);
});
