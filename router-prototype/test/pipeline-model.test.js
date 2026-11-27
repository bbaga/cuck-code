"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { textToModel, modelToText, paletteFromCatalog } = require("../pipeline-model");
const { validateText } = require("../pipelines-api");
const { buildCatalog } = require("../plugin-catalog");
const { NODE_KEYS } = require("../pipelines");
const { startRouter, stopRouter } = require("./fixtures/router-process");

const ROOT = path.join(__dirname, "..");
const catalog = buildCatalog({ builtInDir: ROOT });
const check = (text) => validateText({ text, catalog, managedDir: os.tmpdir(), builtInNames: [] }).errors;

const COMMENTED = `# top comment
name: demo # name comment
description: A demo.
start: a

nodes:
  # node a
  a: { type: planner }
  b:
    type: backend-implementor # keep me
  c: { type: backend-validator, checks: [b] }

edges:
  # first edge
  - a -> b: start, feedback, accept
  - "[b, c] -> a: report"
  - a -> c: start
`;

function roundTrip(text) {
  const { errors, model } = textToModel(text);
  assert.deepEqual(errors, []);
  return modelToText(model, text);
}

test("round trip is byte equal for each file in pipelines/", () => {
  const dir = path.join(ROOT, "pipelines");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  assert.ok(files.length >= 6);
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    assert.equal(roundTrip(text), text, f);
  }
});

test("round trip is byte equal with comments, flow nodes and a grouped edge", () => {
  assert.equal(roundTrip(COMMENTED), COMMENTED);
});

test("model shape", () => {
  const { model } = textToModel(COMMENTED);
  assert.deepEqual(model.nodes.map((n) => n.id), ["a", "b", "c"]);
  assert.deepEqual(model.nodes[0], { id: "a", type: "planner" });
  assert.equal(model.description, "A demo.");
  assert.deepEqual(model.edges.map((e) => [e.from, e.to, e.item]),
    [["a", "b", 0], ["b", "a", 1], ["c", "a", 1], ["a", "c", 2]]);
  assert.deepEqual(model.edges[1].interactions, ["report"]);
});

test("bad YAML gives a LOAD error and no model", () => {
  const r = textToModel("name: [unclosed");
  assert.equal(r.model, null);
  assert.equal(r.errors[0].rule, "LOAD");
  assert.equal(textToModel("- a\n- b\n").errors[0].rule, "LOAD");
});

test("unknown keys stay in the model and in the text", () => {
  const text = `${COMMENTED}extra-key: 5\n`.replace("type: planner }", "type: planner, bogus: 1 }");
  const { model } = textToModel(text);
  assert.deepEqual(model.extra, { "extra-key": 5 });
  assert.equal(model.nodes[0].bogus, 1);
  assert.equal(modelToText(model, text), text);
});

test("change one key, remove one key, keep comments", () => {
  const { model } = textToModel(COMMENTED);
  model.nodes[1].model = "m1";
  delete model.nodes[2].checks;
  model.description = null;
  const out = modelToText(model, COMMENTED);
  assert.match(out, /# top comment/);
  assert.match(out, /# node a/);
  assert.match(out, /# first edge/);
  assert.match(out, /model: m1/);
  assert.doesNotMatch(out, /checks/);
  assert.doesNotMatch(out, /description/);
  assert.equal(textToModel(out).model.nodes[2].checks, undefined);
});

test("add, remove and rename a node", () => {
  const { model } = textToModel(COMMENTED);
  model.nodes.push({ id: "d", type: "backend-validator", checks: ["b"] });
  model.edges.push({ from: "d", to: "a", interactions: ["report"] });
  model.edges.push({ from: "a", to: "d", interactions: ["start"] });
  let out = modelToText(model, COMMENTED);
  assert.deepEqual(check(out), []);
  assert.match(out, /# node a/);
  assert.deepEqual(textToModel(out).model.nodes.map((n) => n.id), ["a", "b", "c", "d"]);

  const rem = textToModel(COMMENTED).model;
  rem.nodes = rem.nodes.filter((n) => n.id !== "c");
  rem.edges = rem.edges.filter((e) => e.from !== "c" && e.to !== "c");
  out = modelToText(rem, COMMENTED);
  assert.deepEqual(check(out), []);
  assert.doesNotMatch(out, /backend-validator/);

  const ren = textToModel(COMMENTED).model;
  ren.nodes[1].id = "b2";
  for (const e of ren.edges) { if (e.from === "b") e.from = "b2"; if (e.to === "b") e.to = "b2"; }
  ren.nodes[2].checks = ["b2"];
  out = modelToText(ren, COMMENTED);
  assert.deepEqual(check(out), []);
  assert.deepEqual(textToModel(out).model.nodes.map((n) => n.id), ["a", "b2", "c"]);
});

test("a new interaction on one pair splits a grouped item", () => {
  const { model } = textToModel(COMMENTED);
  model.edges.find((e) => e.from === "c" && e.to === "a").interactions.push("feedback");
  const out = modelToText(model, COMMENTED);
  assert.match(out, /# first edge/);
  assert.match(out, /- a -> b: start, feedback, accept/);
  assert.doesNotMatch(out, /\[b, c\]/);
  const edges = textToModel(out).model.edges;
  const pair = (f, t) => edges.find((e) => e.from === f && e.to === t);
  assert.deepEqual(pair("c", "a").interactions, ["report", "feedback"]);
  assert.deepEqual(pair("b", "a").interactions, ["report"]);
  assert.equal(pair("b", "a").item === pair("c", "a").item, false);
});

test("a model without baseText writes a new document", () => {
  const model = { name: "n", start: "a", nodes: [{ id: "a", type: "planner" }], edges: [] };
  const out = modelToText(model, "");
  assert.deepEqual(textToModel(out).model.nodes, [{ id: "a", type: "planner" }]);
});

test("a model with a wrong shape throws", () => {
  assert.throws(() => modelToText({ name: "n", start: "a", nodes: "x", edges: [] }, ""), /nodes/);
  assert.throws(() => modelToText({ name: "n", start: "a", nodes: [{ type: "x" }], edges: [] }, ""), /id/);
});

test("palette lists the built-in types and interactions", () => {
  const p = paletteFromCatalog(catalog);
  const builtInTypes = Object.keys(catalog.types).filter((n) => catalog.types[n].layer === "built-in");
  assert.ok(builtInTypes.length > 0);
  for (const name of builtInTypes) assert.ok(p.nodeTypes.some((t) => t.name === name), name);
  for (const name of Object.keys(catalog.interactions)) assert.ok(p.interactions.some((i) => i.name === name), name);
  const keys = ["name", "description", "layer", "extends", "session", "workspace", "outcome", "runner", "coordinator", "base", "fields"];
  assert.deepEqual(Object.keys(p.nodeTypes[0]), keys);
  assert.deepEqual(Object.keys(p.interactions[0]),
    ["name", "description", "layer", "effect", "trigger", "target", "when", "fallback", "fields"]);
  assert.deepEqual(p.nodeKeys.keys, NODE_KEYS);
  assert.equal(p.nodeKeys.idPattern, "^[A-Za-z][A-Za-z0-9-]{0,63}$");
  assert.equal(p.nodeTypes.find((t) => t.name === "planner").base, false);
  assert.deepEqual(p.nodeTypes.map((t) => t.name), p.nodeTypes.map((t) => t.name).sort());
});

// ---- routes ----

let root, router;
test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-model-"));
  fs.mkdirSync(path.join(root, "lines"));
  router = await startRouter(path.join(root, "lines"), {});
});
test.after(async () => {
  if (router) await stopRouter(router);
  fs.rmSync(root, { recursive: true, force: true });
});
async function call(method, pathname, body) {
  const res = await fetch(router.base + pathname, { method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("route POST /api/pipelines/model", async () => {
  const ok = await call("POST", "/api/pipelines/model", { text: COMMENTED });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.model.nodes.length, 3);
  const bad = await call("POST", "/api/pipelines/model", { text: "a: [" });
  assert.equal(bad.status, 200);
  assert.equal(bad.body.model, null);
  assert.equal(bad.body.errors[0].rule, "LOAD");
  assert.equal((await call("POST", "/api/pipelines/model", { text: 5 })).status, 400);
  assert.equal((await call("GET", "/api/pipelines/model")).status, 405);
});

test("route POST /api/pipelines/text", async () => {
  const { body: { model } } = await call("POST", "/api/pipelines/model", { text: COMMENTED });
  const ok = await call("POST", "/api/pipelines/text", { model, baseText: COMMENTED });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.text, COMMENTED);
  const bad = await call("POST", "/api/pipelines/text", { model: { ...model, nodes: "x" }, baseText: COMMENTED });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error);
  assert.equal((await call("POST", "/api/pipelines/text", {})).status, 400);
  assert.equal((await call("PUT", "/api/pipelines/text", {})).status, 405);
});

test("route GET /api/pipelines/palette", async () => {
  const ok = await call("GET", "/api/pipelines/palette");
  assert.equal(ok.status, 200);
  assert.ok(ok.body.nodeTypes.some((t) => t.name === "planner"));
  assert.deepEqual(ok.body.nodeKeys.keys, NODE_KEYS);
  assert.equal((await call("POST", "/api/pipelines/palette", {})).status, 405);
});
