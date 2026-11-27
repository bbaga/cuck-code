"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("../web/pipeline-canvas");

const model = () => ({
  name: "demo", start: "planner", defaults: {}, extra: {},
  nodes: [{ id: "planner", type: "planner" }, { id: "impl", type: "implementor" }, { id: "check", type: "validator" }],
  edges: [{ from: "planner", to: "impl", interactions: ["start", "feedback", "accept"] },
    { from: "impl", to: "check", interactions: ["report"] }],
});
const box = (x, y) => ({ x, y, width: 190, height: 68 });

test("nextNodeId: type name, then -2, -3, and the id pattern", () => {
  const m = model();
  assert.equal(c.nextNodeId(m, "tester"), "tester");
  assert.equal(c.nextNodeId(m, "planner"), "planner-2");
  m.nodes.push({ id: "planner-2", type: "planner" });
  assert.equal(c.nextNodeId(m, "planner", "^[a-z][a-z0-9-]*$"), "planner-3");
  assert.equal(c.nextNodeId(m, "Planner", "^[a-z][a-z0-9-]*$").startsWith("Planner-"), true, "bounded when no id fits");
});

test("anchorPoints: the middle of each side", () => {
  assert.deepEqual(c.anchorPoints(box(10, 20)), { top: { x: 105, y: 20 }, right: { x: 200, y: 54 },
    bottom: { x: 105, y: 88 }, left: { x: 10, y: 54 } });
});

test("nearestAnchorPair: the shortest distance", () => {
  assert.deepEqual(c.nearestAnchorPair(box(0, 0), box(400, 0)), { fromAnchor: "right", toAnchor: "left" });
  assert.deepEqual(c.nearestAnchorPair(box(400, 0), box(0, 0)), { fromAnchor: "left", toAnchor: "right" });
  assert.deepEqual(c.nearestAnchorPair(box(0, 0), box(0, 300)), { fromAnchor: "bottom", toAnchor: "top" });
  const same = box(0, 0);
  assert.deepEqual(c.nearestAnchorPair(same, same), { fromAnchor: "right", toAnchor: "top" });
});

test("paletteGroups: the written order, base types last", () => {
  const t = (name, extra) => ({ name, ...extra });
  const groups = c.paletteGroups({ nodeTypes: [
    t("validator", { base: true, workspace: "source" }), t("zeta", { workspace: "none" }), t("checker", { workspace: "integration" }),
    t("implementor", { base: true, workspace: "own-worktree" }), t("backend", { workspace: "own-worktree" }),
    t("planner", { coordinator: true }), t("alpha", { workspace: "source" }),
  ] });
  assert.deepEqual(groups.map((g) => g.title), ["Planner types", "Worker types", "Checker types", "Other types", "Base types"]);
  assert.deepEqual(groups.map((g) => g.types.map((x) => x.name)),
    [["planner"], ["backend"], ["alpha", "checker"], ["zeta"], ["implementor", "validator"]]);
  assert.deepEqual(c.paletteGroups({ nodeTypes: [t("only", { coordinator: true })] }).map((g) => g.key), ["planner"]);
  assert.deepEqual(c.paletteGroups(null), []);
});

test("arrowsOf: one arrow for each interaction", () => {
  const arrows = c.arrowsOf(model());
  assert.deepEqual(arrows.map((a) => a.key), ["planner->impl:start", "planner->impl:feedback", "planner->impl:accept", "impl->check:report"]);
  assert.deepEqual(arrows[1], { key: "planner->impl:feedback", from: "planner", to: "impl", interaction: "feedback" });
});

test("anchorOffsets: two arrows in and two out at one anchor have four offsets", () => {
  const arrows = [
    { key: "a->b:x", from: "a", to: "b", interaction: "x" }, { key: "a->b:y", from: "a", to: "b", interaction: "y" },
    { key: "b->a:x", from: "b", to: "a", interaction: "x" }, { key: "b->a:y", from: "b", to: "a", interaction: "y" },
  ];
  const stored = { fromAnchor: "right", toAnchor: "left" };
  // every arrow ends at the right anchor of a: the a->b arrows start there, the b->a arrows arrive there
  const layout = { nodes: { a: box(0, 0), b: box(400, 0) }, arrows: {
    "a->b:x": stored, "a->b:y": stored, "b->a:x": { fromAnchor: "left", toAnchor: "right" }, "b->a:y": { fromAnchor: "left", toAnchor: "right" } } };
  const routes = c.anchorOffsets(arrows, layout);
  const atA = [routes["a->b:x"].fromOffset, routes["a->b:y"].fromOffset, routes["b->a:x"].toOffset, routes["b->a:y"].toOffset];
  assert.equal(new Set(atA).size, 4);
  assert.deepEqual([...atA].sort((p, q) => p - q), [-12, -4, 4, 12], "steps of 8 px around the anchor");
  const again = c.anchorOffsets(arrows, layout);
  assert.deepEqual(again, routes, "same input, same offsets");
});

test("anchorOffsets: a single arrow has no offset; without stored anchors the nearest pair is used", () => {
  const arrows = c.arrowsOf(model()).slice(3);
  const routes = c.anchorOffsets(arrows, { nodes: { impl: box(0, 0), check: box(400, 0) }, arrows: {} });
  assert.deepEqual(routes["impl->check:report"], { fromAnchor: "right", toAnchor: "left", fromOffset: 0, toOffset: 0, rank: 0 });
});

test("offsetPoint and arrowCurve", () => {
  assert.deepEqual(c.offsetPoint(box(0, 0), "top", 8), { x: 103, y: 0 });
  assert.deepEqual(c.offsetPoint(box(0, 0), "right", -8), { x: 190, y: 26 });
  const curve = c.arrowCurve({ x: 0, y: 0 }, "right", { x: 100, y: 0 }, "left", 0.5);
  assert.match(curve.d, /^M0 0 C/);
  assert.equal(curve.labelX, 50);
  assert.equal(curve.labelY, 0);
});

test("nextFreePosition: the next free grid cell", () => {
  assert.deepEqual(c.nextFreePosition([]), { x: 20, y: 20 });
  assert.deepEqual(c.nextFreePosition([box(20, 20)]), { x: 250, y: 20 });
  const row = [20, 250, 480, 710].map((x) => box(x, 20));
  assert.deepEqual(c.nextFreePosition(row), { x: 20, y: 120 });
});

test("removeNode: the node and all its edges go; start keeps its value", () => {
  const m = model();
  const out = c.removeNode(m, "planner");
  assert.deepEqual(out.nodes.map((n) => n.id), ["impl", "check"]);
  assert.deepEqual(out.edges.map((e) => e.from + ">" + e.to), ["impl>check"]);
  assert.equal(out.start, "planner");
  assert.equal(m.nodes.length, 3, "the input model is not changed");
  assert.equal(c.removeNode(m, "impl").edges.length, 0);
});

test("removeArrow: one interaction goes; an empty edge goes", () => {
  const m = model();
  const out = c.removeArrow(m, "planner", "impl", "feedback");
  assert.deepEqual(out.edges[0].interactions, ["start", "accept"]);
  assert.deepEqual(m.edges[0].interactions, ["start", "feedback", "accept"], "the input model is not changed");
  const gone = c.removeArrow(m, "impl", "check", "report");
  assert.deepEqual(gone.edges.map((e) => e.to), ["impl"]);
});

test("addNode, pruneLayout and layoutInput", () => {
  const m = c.addNode(model(), "extra", "tester");
  assert.deepEqual(m.nodes[3], { id: "extra", type: "tester" });
  const layout = { nodes: { planner: { x: 1, y: 2 }, gone: { x: 3, y: 4 } },
    arrows: { "planner->impl:start": { fromAnchor: "top", toAnchor: "top" }, "x->y:z": { fromAnchor: "top", toAnchor: "top" } } };
  assert.deepEqual(c.pruneLayout(layout, m), { nodes: { planner: { x: 1, y: 2 } },
    arrows: { "planner->impl:start": { fromAnchor: "top", toAnchor: "top" } } });
  const input = c.layoutInput(m);
  assert.deepEqual(input.columns, { planner: 0, impl: 1, check: 2, extra: 0 });
  assert.equal(input.relations.length, 2);
});

test("addInteractions: adds the edge when missing, never a second edge, no name twice", () => {
  const m = model();
  const added = c.addInteractions(m, "check", "planner", ["report", "report"]);
  assert.deepEqual(added.edges.at(-1), { from: "check", to: "planner", interactions: ["report"] });
  const more = c.addInteractions(m, "planner", "impl", ["accept", "report"]);
  assert.equal(more.edges.filter((e) => e.from === "planner" && e.to === "impl").length, 1);
  assert.deepEqual(more.edges[0].interactions, ["start", "feedback", "accept", "report"]);
  assert.deepEqual(m.edges[0].interactions, ["start", "feedback", "accept"], "the input is not changed");
});

test("setInteractions: sets the list; an empty list removes the edge", () => {
  const m = model();
  const set = c.setInteractions(m, "planner", "impl", ["accept", "report"]);
  assert.deepEqual(set.edges[0].interactions, ["accept", "report"]);
  assert.equal(c.setInteractions(m, "planner", "impl", []).edges.length, 1);
  assert.deepEqual(c.setInteractions(m, "check", "impl", ["report"]).edges.at(-1).interactions, ["report"]);
});

test("rememberAnchors keeps the anchors of old arrows; pruneLayout removes those of a removed arrow", () => {
  const model1 = model();
  const layout = { nodes: {}, arrows: { "planner->impl:start": { fromAnchor: "top", toAnchor: "top" } } };
  const pair = { fromAnchor: "left", toAnchor: "bottom" };
  const next = c.rememberAnchors(layout, "planner", "impl", ["start", "feedback"], pair);
  assert.deepEqual(next.arrows["planner->impl:start"], { fromAnchor: "top", toAnchor: "top" });
  assert.deepEqual(next.arrows["planner->impl:feedback"], pair);
  const pruned = c.pruneLayout(next, c.removeArrow(model1, "planner", "impl", "start"));
  assert.deepEqual(Object.keys(pruned.arrows), ["planner->impl:feedback"], "start is gone, feedback stays");
});
