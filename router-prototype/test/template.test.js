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
  assert.equal(render("a < b & c > \"d\"", {}), "a < b & c > \"d\"");
});

test("{{a}} and {{a.b}} insert values without escaping", () => {
  assert.equal(render("x={{a}} y={{c.b}}", { a: 5, c: { b: "q" } }), "x=5 y=q");
  assert.equal(render("{{a}}", { a: "<b> & 'q'" }), "<b> & 'q'");
  assert.equal(render("{{a}}", { a: false }), "false");
});

test("a variable with no value throws and names the variable", () => {
  assert.throws(() => render("{{nope}}", {}), (e) => e instanceof TemplateError && /nope/.test(e.message));
  assert.throws(() => render("{{a.b}}", { a: {} }), /a\.b/);
  assert.throws(() => render("{{a.b}}", {}), /a\.b/);
  assert.throws(() => render("{{a}}", { a: null }), /a/);
  assert.throws(() => render("{{a}}", { a: undefined }), /a/);
});

test("{{#if}} with true, with false and with a missing value", () => {
  assert.equal(render("{{#if s}}yes{{/if}}", { s: true }), "yes");
  assert.equal(render("{{#if s}}yes{{/if}}", { s: false }), "");
  assert.equal(render("{{#if s}}yes{{/if}}", {}), "");
  assert.equal(render("{{#if a.b}}yes{{/if}}", {}), "");
  assert.equal(render("{{#if s}}[{{s}}]{{/if}}", { s: "text" }), "[text]");
});

test("{{#each}} walks a list, and {{@root}} reaches the top level", () => {
  assert.equal(
    render("{{#each l}}[{{n}}:{{@root.o}}]{{/each}}", { o: "O", l: [{ n: 1 }, { n: 2 }, { n: 3 }] }),
    "[1:O][2:O][3:O]"
  );
  assert.equal(render("{{#each l}}x{{/each}}", {}), "");
  assert.equal(render("{{#each l}}x{{else}}none{{/each}}", { l: [] }), "none");
});

test("{{else}} and {{#unless}} render for a value that is not set", () => {
  assert.equal(render("{{#if s}}yes{{else}}none{{/if}}", {}), "none");
  assert.equal(render("{{#unless s}}none{{/unless}}", { s: [] }), "none");
  assert.equal(render("{{#unless s}}none{{/unless}}", { s: "" }), "none");
  assert.equal(render("{{#unless s}}none{{/unless}}", { s: null }), "none");
  assert.equal(render("{{#unless s}}none{{/unless}}", { s: "x" }), "");
});

test("nested blocks", () => {
  const t = "{{#if a}}A{{#each b}}B{{x}}{{/each}}{{else}}nob{{/if}}";
  assert.equal(render(t, { a: true, b: [{ x: 1 }, { x: 2 }] }), "AB1B2");
  assert.equal(render(t, { a: true }), "A");
  assert.equal(render(t, {}), "nob");
});

test("a line with only a block tag keeps its line break", () => {
  assert.equal(render("a\n{{#if s}}\nb\n{{/if}}\nc", { s: true }), "a\n\nb\n\nc");
});

test("the task marker is dropped with its line break unless kept", () => {
  assert.equal(render("role\n<!-- task -->\ntask", {}), "role\ntask");
  assert.equal(render("role\n<!-- task -->\ntask", {}, { keepTaskMarker: true }), "role\n<!-- task -->\ntask");
});

test("what Handlebars allows but the router does not", () => {
  for (const text of [
    "{{> partial}}", "{{#with a}}x{{/with}}", "{{lookup a b}}", "{{helper 1}}", "{{#if a b}}x{{/if}}",
    "{{#if (x)}}y{{/if}}", "{{../a}}", "{{this}}", "{{@index}}", "{{{{raw}}}}x{{{{/raw}}}}", "{{#if a}}x{{/if}}{{#foo a}}y{{/foo}}",
  ]) {
    assert.throws(() => parseTemplate(text), TemplateError, text);
  }
  assert.doesNotThrow(() => parseTemplate("{{!-- note --}}{{@root.a.b}}{{#if a}}{{else if b}}{{/if}}"));
});

test("each parse fault throws with the line and column", () => {
  let e = faultOf("ab\n  {{#if s}}\nx");
  assert.ok(e instanceof TemplateError);
  assert.match(e.message, /Section "if" is not closed|Section "s" is not closed/);
  assert.deepEqual([e.line, e.column], [2, 3]);
  e = faultOf("{{#if a}}\n{{/each}}");
  assert.ok(e instanceof TemplateError);
  assert.equal(typeof e.line, "number");
  e = faultOf("x\nyy{{/if}}");
  assert.match(e.message, /no open tag/);
  assert.equal(e.line, 2);
  e = faultOf("a {{b");
  assert.equal(e.line, 1);
});

test("placeholders() lists vars, blocks and the guarding blocks around each var", () => {
  const p = placeholders("{{top}}{{#if a}}{{x}}{{#unless b}}{{y}}{{else}}{{z}}{{/unless}}{{/if}}{{x}}");
  assert.deepEqual([...p.vars].sort(), ["top", "x", "y", "z"]);
  assert.deepEqual([...p.sections.entries()], [["a", { inverted: false }], ["b", { inverted: true }]]);
  assert.deepEqual(p.varSections.get("top"), []);
  assert.deepEqual(p.varSections.get("x"), ["a"]);
  assert.deepEqual(p.varSections.get("y"), ["a"]);
  assert.deepEqual(p.varSections.get("z"), ["a", "b"]);
});

test("placeholders() reads {{@root.x}} as x and an {{#each}} as a guard of its items", () => {
  const p = placeholders("{{#each r}}{{name}}{{@root.integration.branch}}{{/each}}");
  assert.deepEqual([...p.vars].sort(), ["integration.branch", "name"]);
  assert.deepEqual(p.varSections.get("name"), ["r"]);
  assert.deepEqual(p.varSections.get("integration.branch"), ["r"]);
});
