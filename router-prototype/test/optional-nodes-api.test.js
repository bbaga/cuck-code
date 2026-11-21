"use strict";

// Optional nodes: only the planner is mandatory. A line on planner-only and a
// line on implement-only must create, run the planner, and serve the API.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startRouter, stopRouter } = require("./fixtures/router-process");
const { installFakeAgents } = require("./fixtures/fake-agents");
const { loadBuiltinPipeline } = require("../line-graph");

async function call(base, method, pathname, body) {
  const res = await fetch(base + pathname, { method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const ACCEPT_LINE = "on-accept";
let root, router, base, src;
test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "optional-nodes-"));
  const linesDir = path.join(root, "lines");
  fs.mkdirSync(linesDir);
  src = path.join(root, "src", "api");
  fs.mkdirSync(src, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", src, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(src, "a.txt"), "a");
  git("add", ".");
  git("commit", "-qm", "init");
  // A saved implement-only line with one completed implementor on the node "impl".
  const lineDir = path.join(linesDir, ACCEPT_LINE);
  fs.mkdirSync(lineDir);
  const graph = loadBuiltinPipeline("implement-only", fs, path.join(__dirname, ".."));
  const worker = { id: "i1", name: "impl", node: "impl", persona: "backend", role: "implementor",
    status: "completed", repo: "api", branch: "b/impl", runGeneration: 1, lastCompletedInvocationId: "inv-i1",
    lastRunText: "report", sessionId: "s1", harness: "claude" };
  fs.writeFileSync(path.join(lineDir, "line.json"), JSON.stringify({
    id: ACCEPT_LINE, name: ACCEPT_LINE, layout: 2, started: true, planApproved: true, graph,
    repos: [{ name: "api", url: src, path: src }], workers: [worker] }));
  router = await startRouter(linesDir, { ROUTER_ALLOW_LOCAL_REPOS: "1",
    PATH: `${installFakeAgents(root)}:${process.env.PATH}` });
  base = router.base;
});
test.after(async () => {
  if (router) await stopRouter(router);
  fs.rmSync(root, { recursive: true, force: true });
});

const createLine = async (pipelineName) => {
  const out = await call(base, "POST", "/api/lines", { name: pipelineName, pipelineName,
    repos: [{ name: "api", url: src }] });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.id;
};
const post = (id, name, body) => call(base, "POST", `/api/protocol/lines/${id}/interactions/${name}`, body);

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
        const data = b.split("\n").find((l) => l.startsWith("data:"));
        if (!data) continue;
        const msg = JSON.parse(data.slice(5));
        if (msg.type === "state" && msg.lineId === id) return msg.data;
      }
    }
  } finally { ctl.abort(); }
}

async function startPlanner(id) {
  const out = await call(base, "POST", `/api/lines/${id}/prompts`, { text: "Plan the work." });
  assert.equal(out.status, 202, JSON.stringify(out.body));
}

test("planner-only: the planner run starts, the interaction list is empty, the dashboard works", async () => {
  const id = await createLine("planner-only");
  await startPlanner(id);
  const list = await call(base, "GET", `/api/protocol/lines/${id}/interactions`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.interactions, []);
  assert.ok(await dashboardState(id));
  const summary = (await call(base, "GET", "/api/lines")).body.lines.find((l) => l.id === id);
  assert.deepEqual(Object.keys(summary.graph.nodes), ["planner"]);
  assert.equal((await post(id, "start", { to: "impl" })).status, 404);
});

test("planner-only: the deprecated alias routes answer 409", async () => {
  const id = await createLine("planner-only");
  await call(base, "POST", `/api/lines/${id}/approve`);
  const out = await call(base, "POST", `/api/protocol/lines/${id}/workers`,
    { name: "w", prompt: "x" });
  assert.equal(out.status, 409, JSON.stringify(out.body));
  const integration = await call(base, "POST", `/api/protocol/lines/${id}/integration`, { prompt: "x" });
  assert.equal(integration.status, 409, JSON.stringify(integration.body));
});

test("implement-only: start on impl and accept work, the dashboard works", async () => {
  const id = await createLine("implement-only");
  await startPlanner(id);
  await call(base, "POST", `/api/lines/${id}/approve`);
  const list = await call(base, "GET", `/api/protocol/lines/${id}/interactions`);
  assert.deepEqual(list.body.interactions.map((i) => i.name).sort(), ["accept", "feedback", "start"]);
  const started = await post(id, "start", { to: "impl", name: "api-work", repo: "api", task: "Do it." });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.ok(started.body.instance.workerId);
  assert.ok(await dashboardState(id));
});

test("implement-only: accept works without a checker", async () => {
  const out = await post(ACCEPT_LINE, "accept", { instance: "i1", reason: "No check needed." });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual(out.body, { accepted: true, instance: "i1", runId: 1 });
  assert.ok(await dashboardState(ACCEPT_LINE));
});
