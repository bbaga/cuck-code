"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parsePipeline } = require("../pipelines");
const { checkPipeline } = require("../pipeline-rules");

const mk = (session, workspace, outcome, extra = {}) => ({
  session, workspace, outcome, coordinator: false, requires: [], fields: {}, body: "", chain: [], ...extra,
});
const types = {
  planner: mk("resume", "coordinator", "none", { coordinator: true }),
  implementor: mk("resume", "own-worktree", "none"),
  "backend-implementor": mk("resume", "own-worktree", "none"),
  "frontend-implementor": mk("resume", "own-worktree", "none"),
  validator: mk("fresh", "source", "verdict"),
  "backend-validator": mk("fresh", "source", "verdict"),
  "frontend-validator": mk("fresh", "source", "verdict"),
  "integration-validator": mk("fresh", "integration", "verdict", { requires: ["accepted-work"] }),
  "security-reviewer": mk("fresh", "source", "verdict", {
    fields: {
      criteria: { description: "Security checks.", type: "text" },
      ticket: { description: "Ticket id.", type: "string", optional: true },
    },
  }),
};
const interactions = {
  start: { name: "start", effect: "create", trigger: "request", target: "new", fields: {}, body: "" },
  feedback: { name: "feedback", effect: "deliver", trigger: "request", target: "chosen", fields: {}, body: "" },
  report: { name: "report", effect: "deliver", trigger: "complete", target: "starter", fields: {}, body: "" },
  accept: { name: "accept", effect: "accept", trigger: "request", target: "chosen", fields: {}, body: "" },
  "spawn-done": { name: "spawn-done", effect: "create", trigger: "complete", target: "new", fields: {}, body: "" },
};

const readFile = () => { throw new Error("no files"); };
const parse = (text) => parsePipeline(text, "/p/pipelines/p.yaml", readFile);
const check = (p) => checkPipeline(p, types, interactions);
const rules = (p) => [...new Set(check(p).map((e) => e.rule))].sort();

const DEFAULT = `
name: default
start: planner
nodes:
  planner:       { type: planner }
  backend-impl:  { type: backend-implementor }
  frontend-impl: { type: frontend-implementor }
  backend-val:   { type: backend-validator, checks: [backend-impl] }
  frontend-val:  { type: frontend-validator, checks: [frontend-impl] }
  integration:   { type: integration-validator }
edges:
  - planner -> [backend-impl, frontend-impl]: start, feedback, accept
  - "[backend-impl, frontend-impl] -> planner: report"
  - planner -> [backend-val, frontend-val]: start
  - "[backend-val, frontend-val] -> planner: report"
  - planner -> integration: start
  - integration -> planner: report
`;
const REVIEW_GATE = `
name: review-gate
start: planner
nodes:
  planner: { type: planner }
  A:       { type: implementor, harness: vibe, model: glm-5-3-flash }
  B:       { type: security-reviewer }
edges:
  - planner -> A: start, feedback
  - A -> planner: report
  - planner -> B: start
  - B -> planner: report
`;

test("good pipelines have no errors", () => {
  assert.deepEqual(check(parse(DEFAULT)), []);
  assert.deepEqual(check(parse(REVIEW_GATE)), []);
});

test("R1: start node must exist", () => {
  const p = parse(REVIEW_GATE);
  p.start = "ghost";
  const errors = check(p);
  assert.deepEqual(rules(p), ["R1"]);
  assert.match(errors[0].message, /ghost/);
});

test("R2: every node is reachable through create edges", () => {
  const p = parse(REVIEW_GATE);
  p.nodes.C = { type: "implementor" };
  p.edges.push({ from: "C", to: "planner", interactions: ["report"] });
  const errors = check(p);
  assert.deepEqual(rules(p), ["R2"]);
  assert.match(errors[0].message, /'C'/);
});

test("R2: a feedback edge does not make a node reachable", () => {
  const p = parse(REVIEW_GATE);
  p.edges = p.edges.filter((e) => !(e.from === "planner" && e.to === "B"));
  p.edges.push({ from: "planner", to: "B", interactions: ["feedback"] });
  assert.ok(check(p).some((e) => e.rule === "R2" && /'B'/.test(e.message)));
});

test("R3: create edges have no cycle", () => {
  const p = parse(REVIEW_GATE);
  p.edges.push({ from: "planner", to: "planner", interactions: ["start"] });
  const errors = check(p);
  assert.deepEqual(rules(p), ["R3"]);
  assert.match(errors[0].message, /planner -> planner/);
});

test("R3: the message names every node of a longer cycle", () => {
  const p = parse(REVIEW_GATE);
  p.edges.push({ from: "A", to: "B", interactions: ["start"] }, { from: "B", to: "A", interactions: ["start"] });
  const r3 = check(p).filter((e) => e.rule === "R3");
  assert.equal(r3.length, 1);
  assert.match(r3[0].message, /A/);
  assert.match(r3[0].message, /B/);
});

test("R4: a node without a complete-triggered edge loses its result", () => {
  const p = parse(REVIEW_GATE);
  p.edges = p.edges.filter((e) => e.from !== "A");
  const errors = check(p);
  assert.deepEqual(rules(p), ["R4"]);
  assert.match(errors[0].message, /'A'/);
});

test("R4: a complete path must end at the start node", () => {
  const p = parse(REVIEW_GATE);
  // B reports to A (source), but A has no way back to the planner.
  p.edges = p.edges.filter((e) => e.from !== "A" && e.from !== "B");
  p.edges.push({ from: "B", to: "A", interactions: ["report"] });
  const errors = check(p).filter((e) => e.rule === "R4");
  assert.ok(errors.length >= 1);
});

test("R4: target starter follows create edges back to the starter", () => {
  const p = parse(DEFAULT);
  assert.deepEqual(check(p), []);
  // integration is started by the planner only, so its report ends at the planner.
  p.edges = p.edges.filter((e) => !(e.from === "integration"));
  assert.deepEqual(rules(p), ["R4"]);
});

test("R5: only the start node uses request-triggered interactions", () => {
  const q = parse(REVIEW_GATE);
  q.edges = q.edges.map((e) => (e.from === "A" ? { ...e, interactions: ["report", "feedback"] } : e));
  const errors = check(q);
  assert.deepEqual(rules(q), ["R5"]);
  assert.match(errors[0].message, /A -> planner/);
});

test("R6: deliver needs a target with session resume", () => {
  const p = parse(REVIEW_GATE);
  p.edges = p.edges.map((e) => (e.to === "B" ? { ...e, interactions: ["start", "feedback"] } : e));
  const errors = check(p);
  assert.deepEqual(rules(p), ["R6"]);
  assert.match(errors[0].message, /'B'/);
});

test("R6: for target starter, check the starter node type", () => {
  const p = parse(REVIEW_GATE);
  p.nodes.planner.type = "validator"; // session fresh
  const errors = check(p).filter((e) => e.rule === "R6");
  assert.ok(errors.length >= 1);
  assert.match(errors[0].message, /session: fresh/);
});

test("R7: a bad node field declaration", () => {
  const p = parse(REVIEW_GATE);
  p.nodes.A.fields = { risk: { description: "Risk.", type: "enum" } };
  const errors = check(p);
  assert.deepEqual(rules(p), ["R7"]);
  assert.match(errors[0].message, /risk/);
});

test("R7: an undeclared caller variable in a node prompt", () => {
  const p = parse(REVIEW_GATE);
  p.nodes.A.prompt = "Level {{riskLevel}} and {{node.id}}.";
  const errors = check(p);
  assert.deepEqual(rules(p), ["R7"]);
  assert.match(errors[0].message, /riskLevel/);
});

test("R7: a caller variable in defaults.prompt must be declared", () => {
  const p = parse(REVIEW_GATE);
  p.defaults = { prompt: "Ticket {{other}}." };
  assert.deepEqual(rules(p), ["R7"]);
  assert.equal(check(p).length, 3); // one per node
});

test("R7: declared in the node fields or the type fields is accepted", () => {
  const p = parse(REVIEW_GATE);
  p.nodes.A.fields = { risk: { description: "Risk.", type: "string" } };
  p.nodes.A.prompt = "Risk {{risk}}.";
  p.nodes.B.prompt = "Checks {{criteria}}.";
  assert.deepEqual(check(p), []);
});

test("R7: an optional field only inside its own section", () => {
  const p = parse(REVIEW_GATE);
  p.nodes.B.prompt = "Ticket {{ticket}}.";
  assert.deepEqual(rules(p), ["R7"]);
  p.nodes.B.prompt = "{{#ticket}}Ticket {{ticket}}.{{/ticket}}";
  assert.deepEqual(check(p), []);
});

test("R8: unknown node type", () => {
  const p = parse(REVIEW_GATE);
  p.nodes.A.type = "nope";
  const errors = check(p);
  assert.deepEqual(rules(p), ["R8"]);
  assert.match(errors[0].message, /nope/);
});

test("R8: unknown interaction", () => {
  const p = parse(REVIEW_GATE);
  p.edges = p.edges.map((e) => (e.from === "planner" && e.to === "A" ? { ...e, interactions: ["start", "shout"] } : e));
  const errors = check(p);
  assert.deepEqual(rules(p), ["R8"]);
  assert.match(errors[0].message, /shout/);
});

test("R8: unknown node in an edge", () => {
  const p = parse(REVIEW_GATE);
  p.edges.push({ from: "planner", to: "ghost", interactions: ["start"] });
  const errors = check(p);
  assert.deepEqual(rules(p), ["R8"]);
  assert.match(errors[0].message, /ghost/);
});

test("R8: unknown node in checks", () => {
  const p = parse(DEFAULT);
  p.nodes["backend-val"].checks = ["backend-impl", "ghost"];
  const errors = check(p);
  assert.deepEqual(rules(p), ["R8"]);
  assert.match(errors[0].message, /ghost/);
});

test("R8: duplicate edge", () => {
  const p = parse(REVIEW_GATE);
  p.edges.push({ from: "planner", to: "B", interactions: ["start"] });
  const errors = check(p);
  assert.deepEqual(rules(p), ["R8"]);
  assert.match(errors[0].message, /duplicate/);
});

test("R9: a node with checks needs workspace source", () => {
  const p = parse(DEFAULT);
  p.nodes["backend-impl"].checks = ["frontend-impl"];
  const errors = check(p);
  assert.deepEqual(rules(p), ["R9"]);
  assert.match(errors[0].message, /backend-impl/);
});

test("R9: a checked node needs workspace own-worktree", () => {
  const p = parse(DEFAULT);
  p.nodes["backend-val"].checks = ["planner"];
  const errors = check(p);
  assert.deepEqual(rules(p), ["R9"]);
  assert.match(errors[0].message, /'planner'/);
});

test("R10: a complete-triggered interaction cannot create an instance", () => {
  const p = parse(REVIEW_GATE);
  p.edges = p.edges.filter((e) => !(e.from === "planner" && e.to === "A"));
  p.edges.push({ from: "planner", to: "A", interactions: ["start", "feedback", "spawn-done"] });
  const errors = check(p);
  assert.deepEqual(rules(p), ["R10"]);
  assert.match(errors[0].message, /cannot create an instance/);
});

test("all rules run: errors from several rules come together", () => {
  const p = parse(REVIEW_GATE);
  p.start = "ghost";
  p.nodes.A.type = "nope";
  p.nodes.B.prompt = "{{undeclared}}";
  assert.deepEqual(rules(p), ["R1", "R7", "R8"]);
});
