"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { graphRelations } = require("../graph-relations");

const interactions = {
  start: { effect: "create", trigger: "request" },
  feedback: { effect: "deliver", trigger: "request" },
  report: { effect: "deliver", trigger: "complete" },
  "spawn-done": { effect: "create", trigger: "complete" },
};
const types = {
  planner: { workspace: "coordinator", requires: [] },
  impl: { workspace: "own-worktree", requires: [] },
  val: { workspace: "source", requires: [] },
  ci: { workspace: "source", requires: [], runner: "script" },
  integ: { workspace: "integration", requires: ["accepted-work"] },
  gate: { workspace: "source", requires: ["accepted-work"] },
};
const edge = (from, to, ...names) => ({ from, to, interactions: names });
const mk = (nodes, edges, start = "planner") => ({ start, nodes, edges, interactions, types });
const rel = (g, kind) => graphRelations(g).relations.filter((r) => r.kind === kind);

const CUCK_CI_NODES = {
  planner: { type: "planner" },
  "backend-impl": { type: "impl" },
  "backend-val": { type: "val", checks: ["backend-impl"], after: ["ci"] },
  ci: { type: "ci", checks: ["backend-impl"], required: true },
  integration: { type: "integ" },
};
const CUCK_CI_EDGES = [
  edge("planner", "backend-impl", "start", "feedback"),
  edge("backend-impl", "planner", "report"),
  edge("planner", "backend-val", "start"),
  edge("planner", "ci", "start"),
  edge("backend-val", "planner", "report"),
  edge("ci", "planner", "report"),
  edge("planner", "integration", "start"),
  edge("integration", "planner", "report"),
];
const cuckCi = () => mk(JSON.parse(JSON.stringify(CUCK_CI_NODES)), CUCK_CI_EDGES);

test("interaction relations: one per edge, label, ordering and dashed", () => {
  const out = rel(cuckCi(), "interaction");
  assert.equal(out.length, CUCK_CI_EDGES.length);
  assert.deepEqual(out[0], { from: "planner", to: "backend-impl", kind: "interaction", label: "start, feedback",
    interactions: ["start", "feedback"], ordering: true, dashed: false });
  assert.deepEqual(out[1], { from: "backend-impl", to: "planner", kind: "interaction", label: "report",
    interactions: ["report"], ordering: false, dashed: true });
  const mixed = rel(mk({ planner: { type: "planner" }, a: { type: "impl" } },
    [edge("planner", "a", "spawn-done", "feedback")]), "interaction")[0];
  assert.deepEqual([mixed.ordering, mixed.dashed], [true, false]);
});

test("checks relation: W -> C, label checks, ordering", () => {
  const out = rel(cuckCi(), "checks");
  assert.deepEqual(out, [
    { from: "backend-impl", to: "backend-val", kind: "checks", label: "checks", ordering: true },
    { from: "backend-impl", to: "ci", kind: "checks", label: "checks", ordering: true },
  ]);
});

test("after relation: X -> C, label after PASS, ordering", () => {
  assert.deepEqual(rel(cuckCi(), "after"),
    [{ from: "ci", to: "backend-val", kind: "after", label: "after PASS", ordering: true }]);
});

test("accepted-work relation: each own-worktree node -> each node that requires it", () => {
  assert.deepEqual(rel(cuckCi(), "accepted-work"),
    [{ from: "backend-impl", to: "integration", kind: "accepted-work", label: "accepted work", ordering: true }]);
});

test("required relation: a required script node -> each node that requires accepted work", () => {
  assert.deepEqual(rel(cuckCi(), "required"),
    [{ from: "ci", to: "integration", kind: "required", label: "required PASS", ordering: true }]);
});

test("relations come in the order edges, checks, after, accepted-work, required", () => {
  const kinds = graphRelations(cuckCi()).relations.map((r) => r.kind);
  assert.deepEqual([...new Set(kinds)], ["interaction", "checks", "after", "accepted-work", "required"]);
});

test("cuck-ci columns and rows", () => {
  const out = graphRelations(cuckCi());
  assert.deepEqual(out.columns, { planner: 0, "backend-impl": 1, ci: 2, "backend-val": 3, integration: 4 });
  assert.equal(out.cycle, null);
  assert.equal(out.cycleCauses, null);
  assert.equal(out.rows.planner, 0);
});

test("the default pipeline columns", () => {
  const nodes = {
    planner: { type: "planner" }, "backend-impl": { type: "impl" }, "frontend-impl": { type: "impl" },
    "backend-val": { type: "val", checks: ["backend-impl"] }, "frontend-val": { type: "val", checks: ["frontend-impl"] },
    integration: { type: "integ" },
  };
  const edges = [
    edge("planner", "backend-impl", "start"), edge("planner", "frontend-impl", "start"),
    edge("backend-impl", "planner", "report"), edge("frontend-impl", "planner", "report"),
    edge("planner", "backend-val", "start"), edge("planner", "frontend-val", "start"),
    edge("backend-val", "planner", "report"), edge("frontend-val", "planner", "report"),
    edge("planner", "integration", "start"), edge("integration", "planner", "report"),
  ];
  assert.deepEqual(graphRelations(mk(nodes, edges)).columns, {
    planner: 0, "backend-impl": 1, "frontend-impl": 1, "backend-val": 2, "frontend-val": 2, integration: 3 });
});

test("cuck-ci without after: backend-val is in column 2", () => {
  const g = cuckCi();
  delete g.nodes["backend-val"].after;
  assert.equal(graphRelations(g).columns["backend-val"], 2);
});

test("rows follow the edge list", () => {
  const g = cuckCi();
  g.nodes["backend-val"].after = [];
  const first = graphRelations({ ...g, edges: [
    edge("planner", "backend-impl", "start"), edge("planner", "backend-val", "start"), edge("planner", "ci", "start")] });
  assert.equal(first.columns["backend-val"], first.columns.ci);
  assert.deepEqual([first.rows["backend-val"], first.rows.ci], [0, 1]);
  const swapped = graphRelations({ ...g, edges: [
    edge("planner", "backend-impl", "start"), edge("planner", "ci", "start"), edge("planner", "backend-val", "start")] });
  assert.deepEqual([swapped.rows["backend-val"], swapped.rows.ci], [1, 0]);
});

test("a node that nothing orders is in column 0", () => {
  const g = mk({ planner: { type: "planner" }, a: { type: "impl" }, loose: { type: "val" } },
    [edge("planner", "a", "start")]);
  assert.equal(graphRelations(g).columns.loose, 0);
  assert.equal(graphRelations(g).columns.a, 1);
});

test("a loop of 2 nodes through after", () => {
  const g = mk({
    planner: { type: "planner" }, impl: { type: "impl" },
    ci: { type: "ci", checks: ["impl"], after: ["lint"] }, lint: { type: "ci", checks: ["impl"], after: ["ci"] },
  }, [edge("planner", "impl", "start")]);
  const out = graphRelations(g);
  assert.deepEqual(out.cycle, ["ci", "lint", "ci"]);
  assert.deepEqual(out.cycleCauses, ["lint: after [ci]", "ci: after [lint]"]);
  assert.equal(out.columns.impl, 1);
  assert.deepEqual([out.columns.ci, out.columns.lint], [2, 3]);
});

test("a loop of 3 nodes through after", () => {
  const g = mk({
    planner: { type: "planner" }, impl: { type: "impl" },
    a: { type: "ci", checks: ["impl"], after: ["c"] }, b: { type: "ci", checks: ["impl"], after: ["a"] },
    c: { type: "ci", checks: ["impl"], after: ["b"] },
  }, []);
  const out = graphRelations(g);
  assert.deepEqual(out.cycle, ["a", "b", "c", "a"]);
  assert.deepEqual(out.cycleCauses, ["b: after [a]", "c: after [b]", "a: after [c]"]);
  assert.ok(["a", "b", "c"].every((id) => Number.isInteger(out.columns[id])));
});

test("a loop found only through a node later in the nodes order", () => {
  const g = mk({
    planner: { type: "planner" }, impl: { type: "impl" }, free: { type: "val", checks: ["impl"] },
    x: { type: "ci", checks: ["impl"], after: ["y"] }, y: { type: "ci", checks: ["impl"], after: ["x"] },
  }, [edge("planner", "impl", "start")]);
  const out = graphRelations(g);
  assert.deepEqual(out.cycle, ["x", "y", "x"]);
  assert.equal(out.columns.free, 2, "a node outside the loop is placed normally");
  assert.ok(out.columns.x >= 2 && out.columns.y >= 2);
});

test("a loop through the start node is reported with its cause", () => {
  const g = mk({ planner: { type: "planner" }, x: { type: "impl" } },
    [edge("planner", "x", "start"), edge("x", "planner", "start")]);
  const out = graphRelations(g);
  assert.deepEqual(out.cycle, ["planner", "x", "planner"]);
  assert.deepEqual(out.cycleCauses, ["planner -> x: start", "x -> planner: start"]);
  assert.equal(out.columns.planner, 0);
});

test("start plus report pairs are no loop", () => {
  const g = mk({ planner: { type: "planner" }, a: { type: "impl" }, b: { type: "impl" } },
    [edge("planner", "a", "start"), edge("a", "planner", "report"), edge("planner", "b", "start"), edge("b", "planner", "report")]);
  assert.equal(graphRelations(g).cycle, null);
});

test("two sibling checkers of one node are no loop", () => {
  const g = mk({ planner: { type: "planner" }, impl: { type: "impl" },
    v1: { type: "val", checks: ["impl"] }, v2: { type: "val", checks: ["impl"] } }, [edge("planner", "impl", "start")]);
  const out = graphRelations(g);
  assert.equal(out.cycle, null);
  assert.deepEqual([out.columns.v1, out.columns.v2], [2, 2]);
});

test("a checker type that also requires accepted-work is no loop", () => {
  const g = mk({ planner: { type: "planner" }, impl: { type: "impl" }, g1: { type: "gate", checks: ["impl"] } },
    [edge("planner", "impl", "start"), edge("planner", "g1", "start")]);
  const out = graphRelations(g);
  assert.equal(out.cycle, null);
  assert.equal(out.columns.g1, 2);
});

test("renaming every node and type gives the same layout", () => {
  const base = graphRelations(cuckCi());
  const nodeMap = { planner: "n0", "backend-impl": "n1", "backend-val": "n2", ci: "n3", integration: "n4" };
  const typeMap = { planner: "t0", impl: "t1", val: "t2", ci: "t3", integ: "t4", gate: "t5" };
  const nodes = {};
  for (const [id, n] of Object.entries(CUCK_CI_NODES)) {
    const copy = { ...n, type: typeMap[n.type] };
    if (n.checks) copy.checks = n.checks.map((x) => nodeMap[x]);
    if (n.after) copy.after = n.after.map((x) => nodeMap[x]);
    nodes[nodeMap[id]] = copy;
  }
  const renamedTypes = Object.fromEntries(Object.entries(types).map(([k, v]) => [typeMap[k], v]));
  const out = graphRelations({ start: "n0", nodes, interactions, types: renamedTypes,
    edges: CUCK_CI_EDGES.map((e) => ({ ...e, from: nodeMap[e.from], to: nodeMap[e.to] })) });
  const back = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [Object.keys(nodeMap).find((o) => nodeMap[o] === k), v]));
  assert.deepEqual(back(out.columns), base.columns);
  assert.deepEqual(back(out.rows), base.rows);
  assert.deepEqual(out.relations.map((r) => ({ ...r, from: Object.keys(nodeMap).find((o) => nodeMap[o] === r.from),
    to: Object.keys(nodeMap).find((o) => nodeMap[o] === r.to) })), base.relations);
});

test("missing keys read as defaults", () => {
  const out = graphRelations({ start: "p", nodes: { p: { type: "zzz" } } });
  assert.deepEqual(out, { relations: [], columns: { p: 0 }, rows: { p: 0 }, cycle: null, cycleCauses: null });
});
