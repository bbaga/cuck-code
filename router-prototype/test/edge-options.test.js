"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { edgeOptions, catalogInputs } = require("../edge-options");
const { parsePipeline } = require("../pipelines");
const { buildCatalog } = require("../plugin-catalog");
const { startRouter, stopRouter } = require("./fixtures/router-process");

const ROOT = path.join(__dirname, "..");
const catalog = buildCatalog({ builtInDir: ROOT });
const { types, interactions } = catalogInputs(catalog);

const TWO_NODES = `name: two
description: Two nodes.
start: planner
nodes:
  planner: { type: planner }
  impl: { type: backend-implementor }
edges: []
`;

function parse(text) {
  return parsePipeline(text, "pipelines/t.yaml", catalog.readFile);
}
function fromFile(name) {
  return parse(fs.readFileSync(path.join(ROOT, "pipelines", `${name}.yaml`), "utf8"));
}
function ask(pipeline, from, to) {
  return edgeOptions({ pipeline, types, interactions, from, to });
}
const names = (list) => list.map((i) => i.name);

test("planner -> impl offers start, feedback and accept", () => {
  const out = ask(parse(TWO_NODES), "planner", "impl");
  for (const n of ["start", "feedback", "accept"]) assert.ok(names(out.options).includes(n), n);
  for (const n of ["report", "handoff", "rework", "arrive"]) assert.ok(!names(out.options).includes(n), n);
  // No rule catches this: the start node has no starter, so edge-options checks it.
  const report = out.excluded.find((i) => i.name === "report");
  assert.ok(report.reasons.includes("node 'planner' is the start node and has no starter"));
});

test("report follows the starter of the sender", () => {
  assert.ok(names(ask(parse(TWO_NODES), "impl", "planner").options).includes("report"));
  const minimal = fromFile("minimal");
  const edge = minimal.edges.find((e) => e.interactions.includes("start"));
  const back = ask(minimal, edge.to, edge.from);
  assert.ok(back.current.includes("report") || names(back.options).includes("report"));
  const text = TWO_NODES.replace("edges: []", "edges:\n  - planner -> impl: start");
  const three = parse(text.replace("impl: { type: backend-implementor }",
    "impl: { type: backend-implementor }\n  other: { type: backend-implementor }"));
  const out = ask(three, "impl", "other");
  assert.ok(!names(out.options).includes("report"));
  assert.ok(out.excluded.find((i) => i.name === "report").reasons.includes("node 'other' does not start node 'impl'"));
});

test("impl -> planner offers report and not start (R5)", () => {
  const out = ask(parse(TWO_NODES), "impl", "planner");
  assert.ok(names(out.options).includes("report"));
  const start = out.excluded.find((i) => i.name === "start");
  assert.ok(start);
  assert.ok(start.reasons.some((r) => r.includes("R5") || /planner/.test(r)));
});

test("a fresh-session target does not offer feedback (R6)", () => {
  const fresh = Object.entries(types).find(([, t]) => t.session === "fresh" && t.runner !== "wait");
  assert.ok(fresh, "a fresh type exists");
  const text = TWO_NODES.replace("backend-implementor", fresh[0]);
  const out = ask(parse(text), "planner", "impl");
  assert.ok(!names(out.options).includes("feedback"));
  assert.ok(names(out.excluded).includes("feedback"));
});

test("rework is offered from a checker only to a node in its checks (R15)", () => {
  const p = fromFile("example-choreographed");
  const checkers = Object.entries(p.nodes).filter(([, n]) => (n.checks || []).length);
  assert.ok(checkers.length, "the pipeline has a checker");
  const [checkerId, checker] = checkers[0];
  const target = checker.checks[0];
  // The edge exists in the pipeline: rework is current. Without the edge it is an option.
  assert.ok(ask(p, checkerId, target).current.includes("rework"));
  const bare = parse(TWO_NODES.replace("backend-implementor", "backend-implementor")
    .replace("impl: { type: backend-implementor }",
      "impl: { type: backend-implementor }\n  val: { type: backend-validator, checks: [impl] }"));
  assert.ok(names(ask(bare, "val", "impl").options).includes("rework"));
  assert.ok(!names(ask(bare, "val", "planner").options).includes("rework"));
  const other = Object.keys(p.nodes).find((id) => id !== checkerId && !checker.checks.includes(id));
  assert.ok(!names(ask(p, checkerId, other).options).includes("rework"));
});

test("arrive is offered only to a node whose type has runner: wait (R16)", () => {
  const waitType = Object.entries(types).find(([, t]) => t.runner === "wait");
  assert.ok(waitType, "a wait type exists");
  const text = TWO_NODES.replace("impl: { type: backend-implementor }",
    `impl: { type: backend-implementor }\n  gate: { type: ${waitType[0]} }`);
  const p = parse(text);
  assert.ok(names(ask(p, "impl", "gate").options).includes("arrive"));
  assert.ok(!names(ask(p, "gate", "impl").options).includes("arrive"));
  assert.ok(!names(ask(p, "planner", "impl").options).includes("arrive"));
});

test("an interaction on the edge is current, not an option or excluded", () => {
  const p = fromFile("minimal");
  const edge = p.edges[0];
  const out = ask(p, edge.from, edge.to);
  assert.deepEqual(out.current, edge.interactions);
  for (const n of out.current) {
    assert.ok(!names(out.options).includes(n));
    assert.ok(!names(out.excluded).includes(n));
  }
});

test("each excluded item has a reason; lists are sorted", () => {
  const out = ask(fromFile("example-choreographed"), "planner", "backend-impl");
  for (const item of out.excluded) assert.ok(item.reasons.length >= 1, item.name);
  for (const list of [out.options, out.excluded]) assert.deepEqual(names(list), names(list).slice().sort());
});

test("bad nodes give an error", () => {
  const p = parse(TWO_NODES);
  assert.ok(ask(p, "nope", "impl").error);
  assert.ok(ask(p, "planner", "nope").error);
  assert.ok(ask(p, "impl", "impl").error);
});

test("the input pipeline is not changed", () => {
  const p = fromFile("example-choreographed");
  const before = JSON.stringify(p);
  const edge = p.edges[0];
  ask(p, edge.from, edge.to);
  ask(p, "planner", "impl");
  assert.equal(JSON.stringify(p), before);
});

let root, router;
test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "edge-options-"));
  fs.mkdirSync(path.join(root, "lines"));
  router = await startRouter(path.join(root, "lines"), {});
});
test.after(async () => {
  if (router) await stopRouter(router);
  fs.rmSync(root, { recursive: true, force: true });
});
async function call(method, body) {
  const res = await fetch(`${router.base}/api/pipelines/edge-options`, { method,
    headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("route: 200 for a good request, also for an incomplete pipeline", async () => {
  const r = await call("POST", { text: TWO_NODES, from: "planner", to: "impl" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.current, []);
  assert.ok(names(r.body.options).includes("start"));
});

test("route: 400 for broken YAML, unknown node, same node, non-string", async () => {
  const yaml = await call("POST", { text: "name: [", from: "a", to: "b" });
  assert.equal(yaml.status, 400);
  assert.ok(Array.isArray(yaml.body.errors));
  assert.equal((await call("POST", { text: TWO_NODES, from: "planner", to: "nope" })).status, 400);
  assert.equal((await call("POST", { text: TWO_NODES, from: "impl", to: "impl" })).status, 400);
  assert.equal((await call("POST", { text: TWO_NODES, from: 1, to: "impl" })).status, 400);
});

test("route: 405 for GET", async () => {
  assert.equal((await call("GET")).status, 405);
});
