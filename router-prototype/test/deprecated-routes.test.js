"use strict";

// C9: /workers, /continue and /integration are deprecated aliases of the
// start and feedback interactions. Agents are fake: every harness binary is
// a script that sleeps.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { loadBuiltinPipeline } = require("../line-graph");
const { startRouter, stopRouter } = require("./fixtures/router-process");

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
  { encoding: "utf8" }).trim();

async function call(base, method, pathname, body) {
  const res = await fetch(base + pathname, { method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}

let root, router, base, src;
const intLine = "dep-integration";
const wrkLine = "dep-workers";
const bareLine = "dep-bare";
const post = (pathname, body) => call(base, "POST", pathname, body);

function seedLine(linesDir, id, { graph } = {}) {
  const lineDir = path.join(linesDir, id);
  fs.mkdirSync(lineDir);
  const clone = path.join(lineDir, "repos", "api");
  execFileSync("git", ["clone", "-q", src, clone]);
  git(clone, "branch", "b/impl", "origin/b/impl");
  const meta = { id, name: id, layout: 2, started: true, planApproved: true,
    repos: [{ name: "api", url: src, path: clone }],
    workers: [{ id: `${id}-i1`, name: "impl", node: "backend-impl", persona: "backend", role: "implementor",
      status: "completed", repo: "api", branch: "b/impl", runGeneration: 1,
      lastCompletedInvocationId: "inv-1", lastRunText: "report", sessionId: "sess-1", harness: "claude",
      acceptedRuns: [{ runId: 1, invocationId: "inv-1", by: "planner" }],
      worktreePath: clone }] };
  if (graph) meta.graph = graph;
  fs.writeFileSync(path.join(lineDir, "line.json"), JSON.stringify(meta));
}

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "deprecated-routes-"));
  const linesDir = path.join(root, "lines");
  fs.mkdirSync(linesDir);
  src = path.join(root, "src", "api");
  fs.mkdirSync(src, { recursive: true });
  git(src, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(src, "a.txt"), "a");
  git(src, "add", ".");
  git(src, "commit", "-qm", "init");
  git(src, "branch", "b/impl");
  // A graph where the planner has no edge to any node: the old routes cannot work.
  const graph = JSON.parse(JSON.stringify(loadBuiltinPipeline("default", fs, path.join(__dirname, ".."))));
  graph.edges = graph.edges.filter((e) => e.from !== graph.start);
  seedLine(linesDir, intLine);
  seedLine(linesDir, wrkLine);
  seedLine(linesDir, bareLine, { graph });
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  for (const agent of ["claude", "vibe", "codex", "pi"]) {
    fs.writeFileSync(path.join(bin, agent), "#!/bin/sh\nsleep 60\n");
    fs.chmodSync(path.join(bin, agent), 0o755);
  }
  router = await startRouter(linesDir, { ROUTER_ALLOW_LOCAL_REPOS: "1", PATH: `${bin}:${process.env.PATH}` });
  base = router.base;
});

test.after(async () => {
  if (router) await stopRouter(router);
  fs.rmSync(root, { recursive: true, force: true });
});

function assertDeprecated(out, lineId) {
  assert.equal(out.headers.get("deprecation"), "true");
  const link = out.headers.get("link");
  assert.ok(link.includes(`/api/protocol/lines/${lineId}/interactions>`), link);
  assert.match(link, /rel="successor-version"/);
}

const stateOf = (line, id) => JSON.parse(fs.readFileSync(path.join(root, "lines", line, "line.json"), "utf8"))
  .workers.find((w) => w.id === id);

test("/workers: success and validation error carry the deprecation headers", async () => {
  const bad = await post(`/api/protocol/lines/${wrkLine}/workers`, {});
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { error: "expected {name, prompt}" });
  assertDeprecated(bad, wrkLine);
  const good = await post(`/api/protocol/lines/${wrkLine}/workers`, { name: "w-ok", prompt: "do it", repo: "api" });
  assert.equal(good.status, 201, JSON.stringify(good.body));
  assertDeprecated(good, wrkLine);
});

test("/continue: success and validation error carry the deprecation headers", async () => {
  const bad = await post(`/api/protocol/workers/${wrkLine}-i1/continue`, {});
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { error: "expected {prompt}" });
  assertDeprecated(bad, wrkLine);
});

test("/integration: success and validation error carry the deprecation headers", async () => {
  const bad = await post(`/api/protocol/lines/${intLine}/integration`, {});
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { error: "expected {prompt}" });
  assertDeprecated(bad, intLine);
  const good = await post(`/api/protocol/lines/${intLine}/integration`, { prompt: "test all" });
  assert.equal(good.status, 201, JSON.stringify(good.body));
  assert.ok(good.body.validatorId && good.body.branch && good.body.worktree);
  assertDeprecated(good, intLine);
  assert.equal(stateOf(intLine, good.body.validatorId).node, "integration");
});

test("an unknown line or worker keeps its 404 and still carries the headers", async () => {
  const a = await post(`/api/protocol/lines/ghost/workers`, { name: "x", prompt: "y" });
  assert.equal(a.status, 404);
  assert.equal(a.headers.get("deprecation"), "true");
  const b = await post(`/api/protocol/lines/ghost/integration`, { prompt: "y" });
  assert.equal(b.status, 404);
  assert.equal(b.headers.get("deprecation"), "true");
  const c = await post(`/api/protocol/workers/ghost/continue`, { prompt: "y" });
  assert.equal(c.status, 404);
  assert.equal(c.headers.get("deprecation"), "true");
  assert.ok(c.headers.get("link").includes("/interactions>"));
});

test("a pipeline without the matching edge answers 409 on all three routes", async () => {
  const w = await post(`/api/protocol/lines/${bareLine}/workers`, { name: "n1", prompt: "p", repo: "api" });
  assert.equal(w.status, 409);
  assert.equal(w.body.error, "this pipeline does not support POST /api/protocol/lines/:id/workers; use POST /api/protocol/lines/:id/interactions/start");
  assertDeprecated(w, bareLine);
  const c = await post(`/api/protocol/workers/${bareLine}-i1/continue`, { prompt: "p" });
  assert.equal(c.status, 409);
  assert.equal(c.body.error, "this pipeline does not support POST /api/protocol/workers/:id/continue; use POST /api/protocol/lines/:id/interactions/feedback");
  assertDeprecated(c, bareLine);
  const i = await post(`/api/protocol/lines/${bareLine}/integration`, { prompt: "p" });
  assert.equal(i.status, 409);
  assert.equal(i.body.error, "this pipeline does not support POST /api/protocol/lines/:id/integration; use POST /api/protocol/lines/:id/interactions/start");
  assertDeprecated(i, bareLine);
});

test("the old and the new route create equivalent instances", async () => {
  const oldOut = await post(`/api/protocol/lines/${wrkLine}/workers`,
    { name: "same-old", prompt: "build it", repo: "api", persona: "frontend", trackerTicket: "ABC-1" });
  const newOut = await post(`/api/protocol/lines/${wrkLine}/interactions/start`,
    { to: "frontend-impl", name: "same-new", task: "build it", repo: "api", trackerTicket: "ABC-1" });
  assert.equal(oldOut.status, 201, JSON.stringify(oldOut.body));
  assert.equal(newOut.status, 201, JSON.stringify(newOut.body));
  assert.deepEqual(Object.keys(newOut.body.instance), Object.keys(oldOut.body));
  assert.equal(oldOut.body.branch.replace("same-old", "N"), newOut.body.instance.branch.replace("same-new", "N"));
  const a = stateOf(wrkLine, oldOut.body.workerId);
  const b = stateOf(wrkLine, newOut.body.instance.workerId);
  assert.equal(a.node, "frontend-impl");
  assert.equal(b.node, a.node);
  for (const key of ["persona", "role", "repo", "kind", "trackerTicket", "status"]) {
    assert.equal(a[key], b[key], key);
  }
  assert.equal(a.prompt.replaceAll("same-old", "N").replaceAll(a.id, "ID"),
    b.prompt.replaceAll("same-new", "N").replaceAll(b.id, "ID").replaceAll(b.worktreePath, a.worktreePath));
});

test("the old /workers route still passes per-worker run settings through", async () => {
  const out = await post(`/api/protocol/lines/${wrkLine}/workers`,
    { name: "with-model", prompt: "x", repo: "api", model: "m-1", effort: "high" });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const w = stateOf(wrkLine, out.body.workerId);
  assert.equal(w.model, "m-1");
  assert.equal(w.effort, "high");
});

test("/continue resumes the implementor through the feedback message", async () => {
  const out = await post(`/api/protocol/workers/${wrkLine}-i1/continue`, { prompt: "Fix it." });
  assert.equal(out.status, 202, JSON.stringify(out.body));
  assert.deepEqual(Object.keys(out.body).sort(), ["compacting", "queued"]);
  assert.ok(out.headers.get("link").includes(`/api/protocol/lines/`));
  assert.equal(out.headers.get("deprecation"), "true");
});
