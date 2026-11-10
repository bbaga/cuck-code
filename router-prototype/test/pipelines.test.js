"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { parsePipeline } = require("../pipelines");
const { FormatError } = require("../frontmatter");

const FILE = "/p/pipelines/review.yaml";
const files = { [path.resolve("/p/pipelines/prompts/pci.md")]: "Check {{riskLevel}}." };
const readFile = (p) => {
  if (!(p in files)) throw new Error(`no such file ${p}`);
  return files[p];
};
const parse = (text) => parsePipeline(text, FILE, readFile);
const BASE = "name: x\nstart: planner\nnodes:\n  planner: { type: planner }\n  A: { type: implementor }\n";
const throwsFile = (text, re) => assert.throws(() => parse(text), (e) => {
  assert.ok(e instanceof FormatError, String(e));
  assert.match(e.message, /review\.yaml/);
  assert.match(e.message, re);
  return true;
});

const GOOD = `
name: review-gate
description: Implement, then review.
start: planner
defaults:
  prompt: |
    Never log tokens {{router.url}}.
nodes:
  planner: { type: planner }
  A: { type: implementor, harness: vibe, model: glm-5-3-flash, effort: high, timeLimit: 600, maxContext: 5000 }
  B:
    type: security-reviewer
    prompt:
      file: prompts/pci.md
    fields:
      riskLevel: { description: The risk., type: enum, values: [low, high] }
    checks: [A]
  C:
    type: implementor
    prompt: Inline {{#riskLevel}}{{riskLevel}}{{/riskLevel}}
edges:
  - planner -> A: start, feedback
  - A -> planner: report
  - planner -> B: start
`;

test("parses a full good file", () => {
  const p = parse(GOOD);
  assert.equal(p.name, "review-gate");
  assert.equal(p.description, "Implement, then review.");
  assert.equal(p.start, "planner");
  assert.match(p.defaults.prompt, /Never log tokens/);
  assert.deepEqual(Object.keys(p.nodes), ["planner", "A", "B", "C"]);
  assert.equal(p.nodes.A.model, "glm-5-3-flash");
  assert.equal(p.nodes.A.maxContext, 5000);
  assert.equal(p.nodes.B.prompt, "Check {{riskLevel}}.");
  assert.deepEqual(p.nodes.B.checks, ["A"]);
  assert.equal(p.nodes.B.fields.riskLevel.type, "enum");
  assert.deepEqual(p.edges, [
    { from: "planner", to: "A", interactions: ["start", "feedback"] },
    { from: "A", to: "planner", interactions: ["report"] },
    { from: "planner", to: "B", interactions: ["start"] },
  ]);
});

test("a minimal file gets defaults", () => {
  const p = parse(BASE);
  assert.deepEqual(p.edges, []);
  assert.deepEqual(p.defaults, {});
  assert.equal(p.description, null);
});

test("bad top keys and values", () => {
  throwsFile(`${BASE}extra: 1\n`, /unknown key 'extra'/);
  throwsFile(BASE.replace("name: x\n", ""), /name is required/);
  throwsFile(BASE.replace("start: planner\n", ""), /start is required/);
  throwsFile(BASE.replace("start: planner", "start: 1bad"), /start is required/);
  throwsFile(`${BASE}description: 5\n`, /description must be a string/);
  throwsFile("name: x\nstart: p\n", /nodes is required/);
  throwsFile("name: x\nstart: p\nnodes: {}\n", /nodes is required/);
  throwsFile("- a\n", /YAML mapping/);
  throwsFile(`${BASE}defaults: { model: x }\n`, /unknown key 'model' in defaults/);
  throwsFile(`${BASE}defaults: 5\n`, /defaults must be a mapping/);
  throwsFile(`${BASE}edges: x\n`, /edges must be a list/);
});

test("an unquoted edge (read by YAML as a one-key mapping) works", () => {
  const p = parse(`${BASE}edges:\n  - planner -> A: start, feedback   # comment\n  - A -> planner:\n`.replace("  - A -> planner:\n", "  - A -> planner: report\n"));
  assert.deepEqual(p.edges[0], { from: "planner", to: "A", interactions: ["start", "feedback"] });
  throwsFile(`${BASE}edges:\n  - planner -> A:\n`, /edge 0 'planner -> A: ': empty interaction name/);
});

test("a YAML fault names the file", () => {
  assert.throws(() => parse("name: [\n"), (e) => e instanceof FormatError && e.file === FILE);
});

test("bad node keys and values", () => {
  throwsFile(`${BASE}  Z: { type: t, bogus: 1 }\n`, /node 'Z': unknown key 'bogus'/);
  throwsFile(`${BASE}  Z: { harness: vibe }\n`, /node 'Z': type is required/);
  throwsFile(`${BASE}  Z: 5\n`, /node 'Z' must be a mapping/);
  throwsFile(`${BASE}  Z: { type: t, harness: nope }\n`, /node 'Z'\.harness must be one of/);
  throwsFile(`${BASE}  Z: { type: t, model: "" }\n`, /node 'Z'\.model must be a non-empty string/);
  throwsFile(`${BASE}  Z: { type: t, effort: max }\n`, /node 'Z'\.effort must be one of/);
  throwsFile(`${BASE}  Z: { type: t, timeLimit: 0 }\n`, /node 'Z'\.timeLimit must be a positive number/);
  throwsFile(`${BASE}  Z: { type: t, maxContext: 5 }\n`, /node 'Z'\.maxContext must be an integer/);
  throwsFile(`${BASE}  "9x": { type: t }\n`, /node id '9x'/);
  throwsFile(`${BASE}  "a_b": { type: t }\n`, /node id 'a_b'/);
  throwsFile(`${BASE}  Z: { type: t, fields: { x: { type: string } } }\n`, /field 'x': description is required/);
  throwsFile(`${BASE}  Z: { type: t, fields: { "line.id": { description: d, type: string } } }\n`, /router variable/);
  throwsFile(`${BASE}  Z: { type: t, fields: [a] }\n`, /fields must be a mapping/);
  throwsFile(`${BASE}  Z: { type: t, checks: A }\n`, /checks must be a list/);
  throwsFile(`${BASE}  Z: { type: t, checks: ["1x"] }\n`, /not a node id/);
});

test("prompt errors", () => {
  throwsFile(`${BASE}  Z: { type: t, prompt: "{{open" }\n`, /node 'Z' prompt: .*not closed/);
  throwsFile(`${BASE}defaults: { prompt: "{{#a}}" }\n`, /defaults prompt: /);
  throwsFile(`${BASE}  Z: { type: t, prompt: 5 }\n`, /prompt must be a string or/);
  throwsFile(`${BASE}  Z: { type: t, prompt: { file: a, other: b } }\n`, /prompt must be a string or/);
  throwsFile(`${BASE}  Z: { type: t, prompt: { file: prompts/missing.md } }\n`, /cannot read file/);
});

test("a prompt file outside the folder is refused", () => {
  for (const f of ["../secret.md", "prompts/../../secret.md", "/etc/passwd", "."]) {
    throwsFile(`${BASE}  Z: { type: t, prompt: { file: "${f}" } }\n`, /outside the folder/);
  }
  throwsFile(`${BASE}defaults: { prompt: { file: ../x.md } }\n`, /outside the folder/);
});

test("a prompt file inside the folder is read through readFile; a template fault in it is reported", () => {
  const seen = [];
  const p = parsePipeline(`${BASE}  Z: { type: t, prompt: { file: prompts/../prompts/pci.md } }\n`, FILE, (x) => { seen.push(x); return "ok"; });
  assert.deepEqual(seen, [path.resolve("/p/pipelines/prompts/pci.md")]);
  assert.equal(p.nodes.Z.prompt, "ok");
  assert.throws(() => parsePipeline(`${BASE}  Z: { type: t, prompt: { file: a.md } }\n`, FILE, () => "{{#x}}"),
    (e) => e instanceof FormatError && /not closed/.test(e.message));
});

test("edges with lists expand to all pairs", () => {
  const p = parse(`${BASE}  B: { type: t }\n  C: { type: t }\nedges:\n  - "[planner, A] -> [B, C]: start, report"\n  - B -> planner : report\n`);
  assert.deepEqual(p.edges, [
    { from: "planner", to: "B", interactions: ["start", "report"] },
    { from: "planner", to: "C", interactions: ["start", "report"] },
    { from: "A", to: "B", interactions: ["start", "report"] },
    { from: "A", to: "C", interactions: ["start", "report"] },
    { from: "B", to: "planner", interactions: ["report"] },
  ]);
});

test("each edge syntax fault names the edge text and index", () => {
  const cases = [
    ["planner A: start", /missing '->'/],
    ["planner -> A", /missing ':'/],
    ["planner -> A:", /empty interaction name/],
    ["planner -> A: start,", /empty interaction name/],
    ["planner -> A: start, start", /listed twice/],
    ["planner -> A: bad_name", /not an interaction name/],
    [" -> A: start", /bad source: missing node id/],
    ["planner -> : start", /bad target: missing node id/],
    ["[planner, ] -> A: start", /bad source: empty entry/],
    ["[] -> A: start", /bad source: empty entry/],
    ["[planner -> A: start", /bad source/],
    ["1x -> A: start", /bad source: '1x' is not a node id/],
    ["planner -> [A B]: start", /bad target/],
  ];
  for (const [edge, re] of cases) {
    const text = `${BASE}edges:\n  - A -> planner: report\n  - ${JSON.stringify(edge)}\n`;
    assert.throws(() => parse(text), (e) => {
      assert.ok(e instanceof FormatError);
      assert.match(e.message, /review\.yaml/);
      assert.match(e.message, /edge 1 /);
      assert.ok(e.message.includes(`'${edge}'`), e.message);
      assert.match(e.message, re);
      return true;
    }, edge);
  }
  throwsFile(`${BASE}edges:\n  - 5\n`, /edge 0 '5': an edge must be a string/);
  throwsFile(`${BASE}edges:\n  - { a: b }\n`, /edge 0 'a: b': missing '->'/);
  throwsFile(`${BASE}edges:\n  - { a: b, c: d }\n`, /edge 0/);
});

test("two edges for the same pair are an error", () => {
  throwsFile(`${BASE}edges:\n  - planner -> A: start\n  - planner -> A: feedback\n`, /edge 1 'planner -> A: feedback': a second edge for planner -> A \(first in edge 0\)/);
  throwsFile(`${BASE}edges:\n  - planner -> A: start\n  - "[planner, A] -> [A]: report"\n`, /edge 1 .*planner -> A/);
  throwsFile(`${BASE}edges:\n  - "[A, A] -> planner: report"\n`, /second edge for A -> planner/);
});

// ---- script check nodes ----

const SCRIPT_BASE = "name: x\nstart: planner\nnodes:\n  planner: { type: planner }\n  A: { type: implementor }\n  ci:\n    type: script-check\n    checks: [A]\n";
const withScripts = (yaml) => SCRIPT_BASE + yaml;
const CI_SCRIPTS = "    scripts:\n      - { name: unit, run: npm test }\n";

test("a script node gets the defaults", () => {
  const ci = parse(withScripts(CI_SCRIPTS)).nodes.ci;
  assert.deepEqual(ci.scripts, [{ name: "unit", run: "npm test", timeout: 600 }]);
  assert.equal(ci.failFast, true);
  assert.equal(ci.required, false);
  assert.equal(ci.checkout, "worktree");
});

test("only a node with scripts gets the script defaults", () => {
  const { A } = parse(withScripts(CI_SCRIPTS)).nodes;
  for (const key of ["scripts", "failFast", "required", "checkout"]) assert.ok(!(key in A), key);
});

test("a full script is read and cwd is normalized", () => {
  const ci = parse(withScripts(`    failFast: false
    required: true
    checkout: clean
    scripts:
      - name: lint.py
        run: ruff check .
        cwd: ./a/b/
        timeout: 7200
        env: { NODE_ENV: test }
        repos: [ml-service]
`)).nodes.ci;
  assert.equal(ci.failFast, false);
  assert.equal(ci.required, true);
  assert.equal(ci.checkout, "clean");
  assert.deepEqual(ci.scripts[0], { name: "lint.py", run: "ruff check .", timeout: 7200, cwd: "a/b",
    env: { NODE_ENV: "test" }, repos: ["ml-service"] });
});

test("bad script specifications name the node and the field", () => {
  const one = (script) => withScripts(`    scripts:\n      - ${script}\n`);
  const bad = [
    [withScripts("    scripts: []\n"), /node 'ci': scripts must be a list of 1 to 50/],
    [withScripts("    scripts: nope\n"), /node 'ci': scripts must be a list/],
    [one("{ run: x }"), /node 'ci': scripts\[0\]: name is required/],
    [one("{ name: Bad, run: x }"), /name is required and must match/],
    [one("{ name: a, run: x, bogus: 1 }"), /unknown key 'bogus'/],
    [one("{ name: a }"), /scripts\[0\] 'a': run is required/],
    [one("{ name: a, run: '' }"), /run is required/],
    [one(`{ name: a, run: ${JSON.stringify("x".repeat(4001))} }`), /run is longer than 4000/],
    [one("{ name: a, run: x, cwd: '' }"), /cwd must be a non-empty string/],
    [one("{ name: a, run: x, cwd: /abs }"), /cwd must be a relative path/],
    [one("{ name: a, run: x, cwd: 'a\\\\b' }"), /cwd must not contain a backslash/],
    [one("{ name: a, run: x, cwd: a/../b }"), /cwd must not contain a '\.\.' segment/],
    [one("{ name: a, run: x, timeout: 0 }"), /timeout must be an integer number of seconds from 1 to 7200/],
    [one("{ name: a, run: x, timeout: 7201 }"), /timeout must be an integer/],
    [one("{ name: a, run: x, timeout: 1.5 }"), /timeout must be an integer/],
    [one("{ name: a, run: x, env: [a] }"), /env must be a mapping/],
    [one("{ name: a, run: x, env: { lower: v } }"), /env key 'lower' must match/],
    [one("{ name: a, run: x, env: { A: 1 } }"), /env 'A' must be a string/],
    [one("{ name: a, run: x, repos: [] }"), /repos must be a non-empty list/],
    [one("{ name: a, run: x, repos: [''] }"), /repos must be a non-empty list/],
    [withScripts("    scripts:\n      - { name: a, run: x }\n      - { name: a, run: y }\n"), /name 'a' is used twice/],
    [withScripts(CI_SCRIPTS + "    failFast: 1\n"), /node 'ci': failFast must be true or false/],
    [withScripts(CI_SCRIPTS + "    required: yes-ish\n"), /node 'ci': required must be true or false/],
    [withScripts(CI_SCRIPTS + "    checkout: copy\n"), /node 'ci': checkout must be one of: worktree, clean/],
  ];
  for (const [text, re] of bad) throwsFile(text, re);
});

test("more than 50 scripts are refused", () => {
  const many = Array.from({ length: 51 }, (_, i) => `      - { name: s${i}, run: x }\n`).join("");
  throwsFile(withScripts(`    scripts:\n${many}`), /1 to 50/);
});

test("after is a non-empty list of node ids on any node", () => {
  assert.deepEqual(parse(`${BASE}  B: { type: validator, checks: [A], after: [A] }\n`).nodes.B.after, ["A"]);
  throwsFile(`${BASE}  B: { type: validator, after: [] }\n`, /node 'B': after must be a non-empty list/);
  throwsFile(`${BASE}  B: { type: validator, after: x }\n`, /node 'B': after must be a non-empty list/);
  throwsFile(`${BASE}  B: { type: validator, after: ['a b'] }\n`, /node 'B': after entry "a b" is not a node id/);
});

test("script keys on an agent node parse and stay for rule R11", () => {
  const b = parse(`${BASE}  B: { type: validator, failFast: false, checkout: clean }\n`).nodes.B;
  assert.equal(b.failFast, false);
  assert.equal(b.checkout, "clean");
});
