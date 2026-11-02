"use strict";

// POST /api/lines/:id/graph through a real router. Agents are fake: every harness binary is a script.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startRouter, stopRouter } = require("./fixtures/router-process");
const { installFakeAgents } = require("./fixtures/fake-agents");
const { loadBuiltinPipeline } = require("../line-graph");

const defaultGraph = loadBuiltinPipeline("default", fs, path.join(__dirname, ".."));

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
  { encoding: "utf8" }).trim();

async function call(method, pathname, body) {
  const res = await fetch(router.base + pathname, { method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let root, router, linesDir, src;
const REMAP = { "backend-impl": "impl", "frontend-impl": "impl", "backend-val": "val", "frontend-val": "val" };
const switchTo = (line, body) => call("POST", `/api/lines/${line}/graph`, body);
const readLine = (id) => JSON.parse(fs.readFileSync(path.join(linesDir, id, "line.json"), "utf8"));

function seedLine(id, { started }) {
  const lineDir = path.join(linesDir, id);
  fs.mkdirSync(lineDir);
  const clone = path.join(lineDir, "repos", "api");
  execFileSync("git", ["clone", "-q", src, clone]);
  const impl = (wid, name, node) => ({ id: wid, name, node, persona: node === "frontend-impl" ? "frontend" : "backend",
    role: "implementor", status: "completed", repo: "api", branch: `b/${id}-${name}`, runGeneration: 1,
    lastCompletedInvocationId: `inv-${wid}`, lastRunText: `report of ${name}`, baseCommit: git(src, "rev-parse", "HEAD"), worktreePath: clone });
  const val = (wid, name, node, validates) => ({ id: wid, name, node, role: "validator", kind: "standard",
    persona: node === "frontend-val" ? "frontend" : "backend", validates, status: "completed" });
  fs.writeFileSync(path.join(lineDir, "line.json"), JSON.stringify({
    id, name: id, layout: 2, started, planApproved: true,
    repos: [{ name: "api", url: src, path: clone }],
    nodeSettings: { "backend-impl": { model: "sonnet" }, "frontend-impl": { model: "haiku" },
      "backend-val": { timeLimit: 600 }, integration: { model: "opus", maxContext: 4000 } },
    graph: defaultGraph,
    workers: [impl("i1", "api", "backend-impl"), impl("i2", "ui", "frontend-impl"),
      val("v1", "api-val", "backend-val", "i1"), val("v2", "ui-val", "frontend-val", "i2"),
      { id: "g1", name: "int", node: "integration", role: "validator", kind: "integration", status: "completed" }] }));
}

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "line-graph-switch-"));
  linesDir = path.join(root, "lines");
  fs.mkdirSync(linesDir);
  src = path.join(root, "src", "api");
  fs.mkdirSync(src, { recursive: true });
  git(src, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(src, "a.txt"), "a");
  git(src, "add", ".");
  git(src, "commit", "-qm", "init");
  for (const id of ["sw-main", "sw-started", "sw-busy", "sw-save", "sw-same"]) seedLine(id, { started: id === "sw-started" || id === "sw-busy" });
  const bin = installFakeAgents(root);
  router = await startRouter(linesDir, { ROUTER_ALLOW_LOCAL_REPOS: "1", PATH: `${bin}:${process.env.PATH}` });
});

test.after(async () => {
  if (router) await stopRouter(router);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an unknown line is 404, an unknown pipeline and a bad body are 400", async () => {
  assert.equal((await switchTo("nope", { pipelineName: "minimal" })).status, 404);
  const unknown = await switchTo("sw-main", { pipelineName: "nope" });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /unknown pipeline 'nope' \(known: .*minimal/);
  assert.equal((await switchTo("sw-main", {})).status, 400);
  for (const remap of ["x", [], { "backend-impl": 3 }]) {
    assert.equal((await switchTo("sw-main", { pipelineName: "minimal", remap })).status, 400, JSON.stringify(remap));
  }
  assert.equal((await switchTo("sw-main", { pipelineName: "minimal", dryRun: "yes" })).status, 400);
});

test("a switch without a remap answers GRAPH_REMAP_REQUIRED with the orphans and their candidates", async () => {
  const out = await switchTo("sw-main", { pipelineName: "minimal" });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, "GRAPH_REMAP_REQUIRED");
  const byNode = Object.fromEntries(out.body.orphans.map((o) => [o.node, o]));
  assert.deepEqual(Object.keys(byNode).sort(), ["backend-impl", "backend-val", "frontend-impl", "frontend-val"]);
  assert.deepEqual(byNode["backend-impl"].candidates, ["impl"]);
  assert.deepEqual(byNode["frontend-val"].candidates, ["val"]);
  assert.deepEqual(byNode["frontend-impl"].workerNames, ["ui"]);
  assert.equal(readLine("sw-main").graph.name, "default", "nothing changed");
});

test("a dry run lists the orphans with 200 and changes nothing", async () => {
  const dry = await switchTo("sw-main", { pipelineName: "minimal", dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.ok, false);
  assert.equal(dry.body.orphans.length, 4);
  assert.deepEqual(dry.body.candidates["backend-val"], ["val"]);
  const full = await switchTo("sw-main", { pipelineName: "minimal", remap: REMAP, dryRun: true });
  assert.equal(full.status, 200);
  assert.equal(full.body.ok, true);
  assert.equal(full.body.moves.length, 4);
  assert.deepEqual(full.body.droppedSettings.sort(), ["frontend-impl"]);
  assert.equal(readLine("sw-main").graph.name, "default");
});

test("an invalid remap is 400 GRAPH_REMAP_INVALID", async () => {
  const out = await switchTo("sw-main", { pipelineName: "minimal", remap: { ...REMAP, "backend-impl": "val" } });
  assert.equal(out.status, 400);
  assert.equal(out.body.code, "GRAPH_REMAP_INVALID");
  assert.ok(out.body.errors.length >= 1);
});

test("switching to the same pipeline is a no-op", async () => {
  const out = await switchTo("sw-same", { pipelineName: "default" });
  assert.equal(out.status, 200);
  assert.equal(out.body.unchanged, true);
  assert.deepEqual(out.body.moves, []);
});

test("a valid remap on an unstarted line rewrites the nodes, carries the settings and queues no notice", async () => {
  const out = await switchTo("sw-main", { pipelineName: "minimal", remap: REMAP });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.noticeQueued, false);
  assert.equal(out.body.graph.name, "minimal");
  assert.deepEqual(out.body.moves.map((m) => `${m.name}:${m.from}>${m.to}`).sort(),
    ["api-val:backend-val>val", "api:backend-impl>impl", "ui-val:frontend-val>val", "ui:frontend-impl>impl"]);
  assert.deepEqual(out.body.droppedSettings, ["frontend-impl"]);
  const saved = readLine("sw-main");
  assert.equal(saved.graph.name, "minimal");
  const nodes = Object.fromEntries(saved.workers.map((w) => [w.name, w.node]));
  assert.deepEqual(nodes, { api: "impl", ui: "impl", "api-val": "val", "ui-val": "val", int: "integration" });
  assert.deepEqual(saved.nodeSettings.impl, { model: "sonnet" });
  assert.deepEqual(saved.nodeSettings.val, { timeLimit: 600 });
  assert.deepEqual(saved.nodeSettings.integration, { model: "opus" }, "fresh node: no maxContext");
  assert.deepEqual(out.body.effectiveNodeSettings.impl.model, "sonnet");
  assert.deepEqual(saved.plannerQueue || [], []);
  assert.equal(saved.activePlannerRequest, null);
});

test("after a switch the line shows the new graph, a call on a new node works and one on an old node is 404", async () => {
  const list = await call("GET", "/api/lines");
  const line = list.body.lines.find((l) => l.id === "sw-main");
  assert.equal(line.graph.name, "minimal");
  assert.ok(line.graph.nodes.impl && !line.graph.nodes["backend-impl"]);
  const old = await call("POST", "/api/protocol/lines/sw-main/interactions/start",
    { to: "backend-impl", task: "t", repo: "api" });
  assert.equal(old.status, 404);
  const fresh = await call("POST", "/api/protocol/lines/sw-main/interactions/start",
    { to: "val", source: "i1", criteria: "1. It works." });
  assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
  // a running instance blocks a further switch
  const blocked = await switchTo("sw-main", { pipelineName: "default", remap: { impl: "backend-impl", val: "backend-val" } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "INSTANCES_RUNNING");
  assert.ok(blocked.body.running.length >= 1);
  assert.equal(readLine("sw-main").graph.name, "minimal");
});

test("a started line gets exactly one new-flow notice with the new protocol and no removed node", async () => {
  const out = await switchTo("sw-started", { pipelineName: "minimal", remap: REMAP });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.noticeQueued, true);
  let saved;
  for (let i = 0; i < 100; i++) {
    saved = readLine("sw-started");
    if (saved.activePlannerRequest || (saved.plannerQueue || []).length) break;
    await wait(50);
  }
  const requests = [...(saved.plannerQueue || []), ...(saved.activePlannerRequest ? [saved.activePlannerRequest] : [])];
  assert.equal(requests.length, 1);
  const [notice] = requests;
  assert.equal(notice.flow, "interactions");
  assert.equal(notice.source, undefined);
  const text = notice.text;
  assert.match(text, /changed from 'default' to 'minimal'/);
  assert.match(text, /api: backend-impl -> impl/);
  assert.match(text, /ui-val: frontend-val -> val/);
  assert.match(text, /### start: node 'impl'/);
  assert.match(text, /### start: node 'val'/);
  assert.match(text, /interactions\/start/);
  for (const old of ["backend-impl", "frontend-impl", "backend-val", "frontend-val"]) {
    assert.ok(!text.includes(`node '${old}'`), `protocol names ${old}`);
    assert.ok(!text.includes(`"to":"${old}"`), `call names ${old}`);
  }
  assert.match(text, /keep the prompt they were created with/);
});

test("a failed save leaves the old graph", { skip: typeof process.getuid === "function" && process.getuid() === 0 }, async () => {
  const dir = path.join(linesDir, "sw-save");
  fs.chmodSync(dir, 0o555);
  let out;
  try { out = await switchTo("sw-save", { pipelineName: "minimal", remap: REMAP }); }
  finally { fs.chmodSync(dir, 0o755); }
  assert.equal(out.status, 500);
  assert.equal(readLine("sw-save").graph.name, "default");
  const list = await call("GET", "/api/lines");
  assert.equal(list.body.lines.find((l) => l.id === "sw-save").graph.name, "default");
  const workers = await call("GET", "/api/protocol/lines/sw-save/workers");
  assert.ok(workers.body.workers.every((w) => w.node !== "impl" && w.node !== "val"));
});

test("a planner that is running blocks the switch", async () => {
  // sw-busy is a started line: send a prompt, then the planner (a fake agent) runs.
  const sent = await call("POST", "/api/lines/sw-busy/prompts", { text: "go" });
  assert.ok(sent.status < 300, JSON.stringify(sent.body));
  for (let i = 0; i < 100; i++) {
    const list = await call("GET", "/api/lines");
    if (list.body.lines.find((l) => l.id === "sw-busy").status === "running") break;
    await wait(50);
  }
  const out = await switchTo("sw-busy", { pipelineName: "minimal", remap: REMAP });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, "PLANNER_BUSY");
  assert.equal(readLine("sw-busy").graph.name, "default");
});
