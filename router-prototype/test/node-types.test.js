"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadNodeType, resolveTypes } = require("../node-types");

function load(dir, text) {
  return loadNodeType(dir, (p) => {
    assert.equal(p, `${dir}/NODE.md`);
    return text;
  });
}

const GOOD = `---
name: reviewer
description: Reviews work.
session: fresh
workspace: source
outcome: verdict
coordinator: false
requires:
  - accepted-work
fields:
  criteria:
    description: Checks.
    type: text
---
Check {{source.name}}:
{{criteria}}
`;

const withHeader = (lines, name = "reviewer") =>
  `---\nname: ${name}\n${lines}\n---\nHello\n`;

function failsWith(fn, re) {
  assert.throws(fn, (err) => {
    assert.equal(err.name, "FormatError");
    assert.match(err.message, re);
    return true;
  });
}

test("loads a good type", () => {
  const t = load("types/reviewer", GOOD);
  assert.equal(t.name, "reviewer");
  assert.equal(t.session, "fresh");
  assert.equal(t.workspace, "source");
  assert.equal(t.outcome, "verdict");
  assert.equal(t.coordinator, false);
  assert.deepEqual(t.requires, ["accepted-work"]);
  assert.equal(t.fields.criteria.type, "text");
  assert.match(t.body, /^Check \{\{source\.name\}\}:/);
  assert.equal(t.file, "types/reviewer/NODE.md");
});

test("a read failure is an error naming the file", () => {
  failsWith(() => loadNodeType("types/x", () => { throw new Error("ENOENT"); }), /types\/x\/NODE\.md/);
});

test("rejects an unknown header key with file and line", () => {
  try {
    load("types/reviewer", withHeader("color: red"));
    assert.fail("should throw");
  } catch (err) {
    assert.equal(err.file, "types/reviewer/NODE.md");
    assert.match(err.message, /types\/reviewer\/NODE\.md/);
    assert.match(err.message, /color/);
  }
});

test("name must equal the folder and match the pattern", () => {
  failsWith(() => load("types/reviewer", withHeader("", "other")), /name/);
  failsWith(() => load("types/Bad", withHeader("", "Bad")), /name/);
  failsWith(() => load("types/reviewer", "---\ndescription: x\n---\nb"), /name/);
});

test("rejects bad values", () => {
  failsWith(() => load("types/reviewer", withHeader("session: maybe")), /session/);
  failsWith(() => load("types/reviewer", withHeader("workspace: moon")), /workspace/);
  failsWith(() => load("types/reviewer", withHeader("outcome: pass")), /outcome/);
  failsWith(() => load("types/reviewer", withHeader("coordinator: yes please")), /coordinator/);
  failsWith(() => load("types/reviewer", withHeader("requires: [other]")), /requires/);
  failsWith(() => load("types/reviewer", withHeader("requires: accepted-work")), /requires/);
});

test("accepts every allowed value", () => {
  for (const s of ["resume", "fresh"]) load("types/reviewer", withHeader(`session: ${s}`));
  for (const w of ["coordinator", "own-worktree", "source", "integration"]) load("types/reviewer", withHeader(`workspace: ${w}`));
  for (const o of ["none", "verdict"]) load("types/reviewer", withHeader(`outcome: ${o}`));
  load("types/reviewer", withHeader("coordinator: true"));
});

test("checks field declarations", () => {
  failsWith(() => load("types/reviewer", withHeader("fields:\n  a:\n    type: string")), /field 'a'/);
  failsWith(() => load("types/reviewer", withHeader("fields:\n  report:\n    description: x\n    type: string")), /router variable/);
  failsWith(() => load("types/reviewer", withHeader("fields: [a]")), /fields/);
});

test("reports template errors with the real file line", () => {
  const text = "---\nname: reviewer\n---\nline one\nline two {{oops\n";
  try {
    load("types/reviewer", text);
    assert.fail("should throw");
  } catch (err) {
    assert.equal(err.line, 5);
    assert.match(err.message, /NODE\.md/);
    assert.match(err.message, /not closed/);
  }
});

function typesOf(specs) {
  const out = {};
  for (const [name, text] of Object.entries(specs)) out[name] = load(`t/${name}`, text);
  return out;
}

const doc = (name, extra, body) => `---\nname: ${name}\n${extra}\n---\n${body}\n`;
const F = (n, more = "") => `fields:\n  ${n}:\n    description: d\n    type: string\n${more}`;
const ROOT = "session: fresh\nworkspace: source\noutcome: none";

test("resolves an extends chain of three", () => {
  const types = typesOf({
    root: doc("root", `session: fresh\nworkspace: source\noutcome: none\ncoordinator: true\n${F("a")}`, "root {{a}}"),
    mid: doc("mid", `extends: root\noutcome: verdict\n${F("b")}`, "mid {{b}}"),
    leaf: doc("leaf", `extends: mid\nsession: resume\n${F("c")}`, "leaf {{c}} {{a}}"),
  });
  const r = resolveTypes(types);
  assert.equal(r.leaf.session, "resume");
  assert.equal(r.leaf.workspace, "source");
  assert.equal(r.leaf.outcome, "verdict");
  assert.equal(r.leaf.coordinator, true);
  assert.deepEqual(Object.keys(r.leaf.fields), ["a", "b", "c"]);
  assert.equal(r.leaf.body, "root {{a}}\n\nmid {{b}}\n\nleaf {{c}} {{a}}\n");
  assert.equal(r.root.body, "root {{a}}\n");
  assert.equal(r.mid.session, "fresh");
});

test("a root without session, workspace or outcome is an error", () => {
  for (const missing of ["session", "workspace", "outcome"]) {
    const keys = { session: "fresh", workspace: "source", outcome: "none" };
    delete keys[missing];
    const extra = Object.entries(keys).map(([k, v]) => `${k}: ${v}`).join("\n");
    failsWith(() => resolveTypes(typesOf({ root: doc("root", extra, "x") })), new RegExp(missing));
  }
});

test("a missing parent is an error", () => {
  failsWith(() => resolveTypes(typesOf({ kid: doc("kid", "extends: nobody", "x") })), /nobody/);
});

test("an extends loop names every type in it", () => {
  const types = typesOf({
    a: doc("a", "extends: b", "x"),
    b: doc("b", "extends: c", "x"),
    c: doc("c", "extends: a", "x"),
  });
  assert.throws(() => resolveTypes(types), (err) => {
    assert.match(err.message, /loop/);
    for (const n of ["a", "b", "c"]) assert.ok(err.message.includes(n), n);
    return true;
  });
});

test("an undeclared placeholder is an error with file and line", () => {
  const types = typesOf({ root: doc("root", ROOT, "hi\nthere {{task}}") });
  try {
    resolveTypes(types);
    assert.fail("should throw");
  } catch (err) {
    assert.equal(err.name, "FormatError");
    assert.match(err.message, /declare field `task` in NODE\.md fields/);
    assert.equal(err.file, "t/root/NODE.md");
    assert.equal(err.line, 8);
  }
});

test("router variables need no declaration", () => {
  resolveTypes(typesOf({ root: doc("root", ROOT, "{{line.id}} {{source.report}} {{outcome}}") }));
});

test("a child may use a parent's field", () => {
  resolveTypes(typesOf({
    root: doc("root", `${ROOT}\n${F("a")}`, "x"),
    kid: doc("kid", "extends: root", "{{a}}"),
  }));
});

test("an optional field outside its section is an error", () => {
  const opt = F("t", "    optional: true\n");
  failsWith(() => resolveTypes(typesOf({ root: doc("root", `${ROOT}\n${opt}`, "bad {{t}}") })), /optional field 't'/);
  resolveTypes(typesOf({ root: doc("root", `${ROOT}\n${opt}`, "{{#t}}ok {{t}}{{/t}}") }));
});

test("a child that changes a parent field is an error", () => {
  const types = typesOf({
    root: doc("root", `${ROOT}\n${F("a")}`, "x"),
    kid: doc("kid", `extends: root\n${F("a", "    maxLength: 5\n")}`, "x"),
  });
  failsWith(() => resolveTypes(types), /field 'a'/);
  resolveTypes(typesOf({
    root: doc("root", `${ROOT}\n${F("a")}`, "x"),
    kid: doc("kid", `extends: root\n${F("a")}`, "x"),
  }));
});
