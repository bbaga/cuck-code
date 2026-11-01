"use strict";

// Router API: node settings. The old per-phase shape answers 400 (removed in D9).
const REMOVED = "the per-phase 'pipeline' shape was removed: send 'nodeSettings' (a map from node id to run settings)";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startRouter, stopRouter } = require("./fixtures/router-process");

async function call(base, method, pathname, body) {
  const res = await fetch(base + pathname, { method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let root, linesDir, router, base;
test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-api-"));
  linesDir = path.join(root, "lines");
  fs.mkdirSync(linesDir);
  router = await startRouter(linesDir, {});
  base = router.base;
});
test.after(async () => {
  if (router) await stopRouter(router);
  fs.rmSync(root, { recursive: true, force: true });
});

const create = (body) => call(base, "POST", "/api/lines", body);
const summary = async (id) => (await call(base, "GET", "/api/lines")).body.lines.find((l) => l.id === id);
const saved = (id) => JSON.parse(fs.readFileSync(path.join(linesDir, id, "line.json"), "utf8"));

async function dashboardState(id) {
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ctl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buf += dec.decode(value, { stream: true });
      const blocks = buf.split("\n\n");
      buf = blocks.pop();
      for (const b of blocks) {
        const line = b.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const msg = JSON.parse(line.slice(5));
        if (msg.type === "state" && msg.lineId === id) return msg.data;
      }
    }
  } finally { ctl.abort(); }
}

test("a line with no settings uses the default pipeline and shows graph, node settings and effective settings", async () => {
  const c = await create({ name: "Plain" });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const s = await summary(c.body.id);
  assert.equal(s.graph.name, "default");
  assert.equal(s.graph.start, "planner");
  assert.deepEqual(s.graph.nodes.planner, { type: "planner", phase: "planner" });
  assert.equal(s.graph.nodes["backend-impl"].phase, "implementor");
  assert.ok(Array.isArray(s.graph.edges) && s.graph.edges.length > 0);
  assert.deepEqual(s.nodeSettings, {});
  // D5: edges carry the effect and trigger of each interaction; fresh-session nodes are listed.
  const toBackend = s.graph.edges.find((e) => e.from === "planner" && e.to === "backend-impl");
  assert.deepEqual(toBackend.kinds.start, { effect: "create", trigger: "request" });
  const report = s.graph.edges.find((e) => e.from === "backend-impl" && e.to === "planner");
  assert.deepEqual(report.kinds.report, { effect: "deliver", trigger: "complete" });
  assert.ok(s.graph.freshNodes.includes("backend-val") && !s.graph.freshNodes.includes("planner"));
  for (const id of Object.keys(s.graph.nodes)) assert.ok(s.effectiveNodeSettings[id].harness, id);
  assert.equal("pipelineOverrides" in s, false);
  assert.equal("pipeline" in s, false);
});

test("pipelineName picks a built-in pipeline; an unknown name lists the known ones", async () => {
  const c = await create({ pipelineName: "minimal" });
  assert.equal(c.status, 201);
  assert.equal((await summary(c.body.id)).graph.name, "minimal");
  assert.equal(saved(c.body.id).graph.name, "minimal");
  const bad = await create({ pipelineName: "nope" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /unknown pipeline 'nope'/);
  assert.match(bad.body.error, /default/);
  assert.match(bad.body.error, /minimal/);
  assert.equal((await create({ pipelineName: 5 })).status, 400);
});

test("POST accepts nodeSettings", async () => {
  const c = await create({ pipelineName: "minimal",
    nodeSettings: { impl: { harness: "vibe", model: "m-impl", effort: "high", maxContext: 50000 }, val: { timeLimit: 99 } } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const s = await summary(c.body.id);
  assert.deepEqual(s.nodeSettings.impl, { harness: "vibe", model: "m-impl", effort: "high", maxContext: 50000 });
  assert.equal(s.effectiveNodeSettings.impl.model, "m-impl");
  assert.equal(s.effectiveNodeSettings.impl.maxContext, 50000);
  assert.equal(s.effectiveNodeSettings.val.timeLimit, 99);
  assert.deepEqual(saved(c.body.id).nodeSettings, s.nodeSettings);
});

test("POST refuses the old per-phase pipeline shape with 400 and the removal message", async () => {
  const c = await create({ pipeline: { implementor: { model: "old-m", effort: "low" }, planner: { timeLimit: 77 } } });
  assert.equal(c.status, 400);
  assert.equal(c.body.error, REMOVED);
  assert.equal((await create({ pipeline: {} })).body.error, REMOVED);
  assert.equal((await create({ nodeSettings: {}, pipeline: {} })).body.error, REMOVED);
});

test("POST errors: unknown node, invalid settings, maxContext on a fresh node", async () => {
  const unknown = await create({ nodeSettings: { ghost: { effort: "low" } } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /ghost/);
  assert.equal((await create({ nodeSettings: { constructor: {} } })).status, 400);
  assert.equal((await create({ nodeSettings: { planner: { harness: "nope" } } })).status, 400);
  assert.equal((await create({ nodeSettings: { planner: { effort: "extreme" } } })).status, 400);
  assert.equal((await create({ nodeSettings: { planner: { bogus: 1 } } })).status, 400);
  assert.equal((await create({ nodeSettings: { planner: "x" } })).status, 400);
  assert.equal((await create({ nodeSettings: [] })).status, 400);
  const fresh = await create({ nodeSettings: { "backend-val": { maxContext: 5000 } } });
  assert.equal(fresh.status, 400);
  assert.match(fresh.body.error, /maxContext/);
});

test("the harness gate sees the harnesses of nodeSettings", async () => {
  assert.equal((await create({ nodeSettings: { planner: { harness: "zzz" } } })).status, 400);
});

test("PUT round trip with nodeSettings", async () => {
  const c = await create({ pipelineName: "minimal" });
  const id = c.body.id;
  const put = await call(base, "PUT", `/api/lines/${id}/pipeline`, {
    nodeSettings: { impl: { model: "put-m", maxContext: 30000 }, planner: { effort: "low" } } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.nodeSettings.impl.model, "put-m");
  assert.equal(put.body.effectiveNodeSettings.impl.maxContext, 30000);
  assert.equal("pipeline" in put.body, false);
  assert.equal("overrides" in put.body, false);
  assert.equal(put.body.graph.name, "minimal");
  const s = await summary(id);
  assert.deepEqual(s.nodeSettings, put.body.nodeSettings);
  assert.deepEqual(saved(id).nodeSettings, s.nodeSettings);
  assert.equal("pipeline" in saved(id), false);
  const state = await dashboardState(id);
  assert.deepEqual(state.nodeSettings, s.nodeSettings);
  assert.equal(state.graph.name, "minimal");
  assert.equal(state.effectiveNodeSettings.impl.model, "put-m");
  assert.equal("pipeline" in state, false);
  assert.equal("pipelineOverrides" in state, false);
  const cleared = await call(base, "PUT", `/api/lines/${id}/pipeline`, { nodeSettings: {} });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.nodeSettings, {});
});

test("PUT refuses the old per-phase pipeline shape with 400 and the removal message", async () => {
  const c = await create({ pipelineName: "minimal", nodeSettings: { val: { effort: "high" } } });
  const id = c.body.id;
  const put = await call(base, "PUT", `/api/lines/${id}/pipeline`, {
    pipeline: { validator: { model: "v-m" }, implementor: { effort: "low" } } });
  assert.equal(put.status, 400);
  assert.equal(put.body.error, REMOVED);
  assert.deepEqual((await summary(id)).nodeSettings, { val: { effort: "high" } });
});

test("a node settings PUT does not leak one node's settings to its phase siblings", async () => {
  const c = await create({});
  const put = await call(base, "PUT", `/api/lines/${c.body.id}/pipeline`, {
    nodeSettings: { "backend-impl": { model: "only-backend" } } });
  assert.equal(put.status, 200);
  assert.equal(put.body.effectiveNodeSettings["backend-impl"].model, "only-backend");
  assert.notEqual(put.body.effectiveNodeSettings["frontend-impl"].model, "only-backend");
});

test("PUT errors", async () => {
  const c = await create({ pipelineName: "minimal" });
  const url = `/api/lines/${c.body.id}/pipeline`;
  assert.equal((await call(base, "PUT", url, { nodeSettings: {}, pipeline: {} })).body.error, REMOVED);
  const unknown = await call(base, "PUT", url, { nodeSettings: { ghost: {} } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /ghost/);
  assert.equal((await call(base, "PUT", url, { nodeSettings: { planner: { effort: "x" } } })).status, 400);
  assert.equal((await call(base, "PUT", url, { nodeSettings: { val: { maxContext: 5000 } } })).status, 400);
  assert.equal((await call(base, "PUT", "/api/lines/missing/pipeline", { nodeSettings: {} })).status, 404);
  assert.deepEqual((await summary(c.body.id)).nodeSettings, {});
});
