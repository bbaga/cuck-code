"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { splitFrontmatter, parseYamlFile, FormatError } = require("../frontmatter");

function fault(fn) {
  try { fn(); } catch (err) { return err; }
  return assert.fail("expected a FormatError");
}

test("good file returns header, body and bodyLine", () => {
  const text = "---\nname: plan\nextends: [a, b]\n---\nHello\nWorld\n";
  const out = splitFrontmatter(text, "NODE.md");
  assert.deepEqual(out.header, { name: "plan", extends: ["a", "b"] });
  assert.equal(out.body, "Hello\nWorld\n");
  assert.equal(out.bodyLine, 5);
});

test("good file with CRLF line endings", () => {
  const out = splitFrontmatter("---\r\nname: x\r\n---\r\nBody", "NODE.md");
  assert.deepEqual(out.header, { name: "x" });
  assert.equal(out.body, "Body");
  assert.equal(out.bodyLine, 4);
});

test("empty body", () => {
  const out = splitFrontmatter("---\nname: x\n---\n", "NODE.md");
  assert.equal(out.body, "");
  assert.equal(out.bodyLine, 4);
  const noNewline = splitFrontmatter("---\nname: x\n---", "NODE.md");
  assert.equal(noNewline.body, "");
  assert.equal(noNewline.bodyLine, 4);
});

test("missing first --- throws FormatError", () => {
  const err = fault(() => splitFrontmatter("name: x\n---\n", "NODE.md"));
  assert.ok(err instanceof FormatError);
  assert.equal(err.file, "NODE.md");
  assert.equal(err.line, 1);
  assert.match(err.message, /---/);
});

test("empty text has no first ---", () => {
  const err = fault(() => splitFrontmatter("", "NODE.md"));
  assert.ok(err instanceof FormatError);
  assert.equal(err.line, 1);
});

test("missing second --- throws FormatError", () => {
  const err = fault(() => splitFrontmatter("---\nname: x\nbody\n", "INTERACTION.md"));
  assert.ok(err instanceof FormatError);
  assert.equal(err.file, "INTERACTION.md");
  assert.equal(err.line, 1);
  assert.match(err.message, /closing/);
});

test("YAML syntax error reports the file line", () => {
  const err = fault(() => splitFrontmatter("---\nname: x\nbad: [1, 2\n---\nbody\n", "NODE.md"));
  assert.ok(err instanceof FormatError);
  assert.equal(err.file, "NODE.md");
  assert.ok(err.line >= 3 && err.line <= 4, `line ${err.line}`);
});

test("header that is not a mapping throws FormatError", () => {
  for (const header of ["- a\n- b", "just text", "42"]) {
    const err = fault(() => splitFrontmatter(`---\n${header}\n---\nbody`, "NODE.md"));
    assert.ok(err instanceof FormatError, header);
    assert.equal(err.line, 2);
    assert.match(err.message, /mapping/);
  }
  const empty = fault(() => splitFrontmatter("---\n---\nbody", "NODE.md"));
  assert.ok(empty instanceof FormatError);
});

test("parseYamlFile parses a good file", () => {
  assert.deepEqual(parseYamlFile("a: 1\nb:\n  - x\n", "p.yml"), { a: 1, b: ["x"] });
});

test("parseYamlFile throws FormatError on a syntax error", () => {
  const err = fault(() => parseYamlFile("a: 1\nb: [1, 2\n", "p.yml"));
  assert.ok(err instanceof FormatError);
  assert.equal(err.file, "p.yml");
  assert.ok(err.line >= 2);
});

test("FormatError carries file, line and message", () => {
  const err = new FormatError("f.md", 3, "boom");
  assert.ok(err instanceof Error);
  assert.equal(err.file, "f.md");
  assert.equal(err.line, 3);
  assert.equal(err.message, "boom");
});
