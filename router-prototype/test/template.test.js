"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TemplateError, parseTemplate, placeholders, render } = require("../template");

function faultOf(text) {
  try { parseTemplate(text); } catch (e) { return e; }
  return assert.fail("expected TemplateError");
}

test("plain text stays the same", () => {
  assert.equal(render("Hello\n  world { } }}", {}), "Hello\n  world { } }}");
  assert.deepEqual(parseTemplate("abc"), [{ type: "text", value: "abc" }]);
});

test("{{a}} and {{a.b}} insert values", () => {
  assert.equal(render("x={{a}} y={{c.b}}", { a: 5, c: { b: "q" } }), "x=5 y=q");
  assert.deepEqual(parseTemplate("{{a.b}}"), [{ type: "var", name: "a.b" }]);
});

test("missing value throws and names the variable", () => {
  assert.throws(() => render("{{nope}}", {}), (e) => e instanceof TemplateError && /nope/.test(e.message));
  assert.throws(() => render("{{a.b}}", { a: {} }), /a\.b/);
});

test("section with true, with false, with a list of three items", () => {
  assert.equal(render("{{#s}}yes{{/s}}", { s: true }), "yes");
  assert.equal(render("{{#s}}yes{{/s}}", { s: false }), "");
  assert.equal(render("{{#s}}yes{{/s}}", {}), "");
  assert.equal(
    render("{{#l}}[{{n}}:{{o}}]{{/l}}", { o: "O", l: [{ n: 1 }, { n: 2, o: "own" }, { n: 3 }] }),
    "[1:O][2:own][3:O]"
  );
});

test("inverted section with a missing value and with a value", () => {
  assert.equal(render("{{^s}}none{{/s}}", {}), "none");
  assert.equal(render("{{^s}}none{{/s}}", { s: [] }), "none");
  assert.equal(render("{{^s}}none{{/s}}", { s: "" }), "none");
  assert.equal(render("{{^s}}none{{/s}}", { s: null }), "none");
  assert.equal(render("{{^s}}none{{/s}}", { s: "x" }), "");
});

test("nested sections", () => {
  const t = "{{#a}}A{{#b}}B{{x}}{{/b}}{{^b}}nob{{/b}}{{/a}}";
  assert.equal(render(t, { a: true, b: [{ x: 1 }, { x: 2 }] }), "AB1B2");
  assert.equal(render(t, { a: true }), "Anob");
  assert.equal(render(t, {}), "");
});

test("each parse fault throws with the correct line and column", () => {
  let e = faultOf("ab\n  {{#s}}\nx");
  assert.ok(e instanceof TemplateError);
  assert.deepEqual([e.line, e.column], [2, 3]);
  e = faultOf("{{#a}}\n{{/b}}");
  assert.deepEqual([e.line, e.column], [2, 1]);
  e = faultOf("x\nyy{{/a}}");
  assert.deepEqual([e.line, e.column], [2, 3]);
  e = faultOf("ok {{1bad}}");
  assert.deepEqual([e.line, e.column], [1, 4]);
  e = faultOf("{{ a }}");
  assert.deepEqual([e.line, e.column], [1, 1]);
  e = faultOf("a {{b");
  assert.deepEqual([e.line, e.column], [1, 3]);
});

test("placeholders() lists vars, sections and the sections that contain each var", () => {
  const p = placeholders("{{top}}{{#a}}{{x}}{{^b}}{{y}}{{/b}}{{/a}}{{x}}");
  assert.deepEqual([...p.vars].sort(), ["top", "x", "y"]);
  assert.deepEqual([...p.sections.entries()], [["a", { inverted: false }], ["b", { inverted: true }]]);
  assert.deepEqual(p.varSections.get("top"), []);
  assert.deepEqual(p.varSections.get("x"), ["a"]);
  assert.deepEqual(p.varSections.get("y"), ["a", "b"]);
});
