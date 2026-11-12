"use strict";

// Script check nodes through a real router. The line is seeded: a pipeline with
// a script node (the README example cuck-ci) and a completed implementor with a
// real git worktree. Scripts are small shell commands. Planner binaries are fakes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { buildCatalog } = require("../plugin-catalog");
const { resolvePipelineDefinition } = require("../resolve-pipeline");
const { startRouter, stopRouter, wait } = require("./fixtures/router-process");

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
  { encoding: "utf8" }).trim();

function graphWith(scripts, checkout) {
  const catalog = buildCatalog({ builtInDir: path.join(__dirname, "..") });
  const list = scripts.map(([name, run]) => `      - { name: ${name}, run: "${run}" }`).join("\n");
  catalog.pipelines["cuck-ci"] = { layer: "managed", text: `name: cuck-ci
start: planner
nodes:
  planner: { type: planner }
  backend-impl: { type: backend-implementor }
  ci:
    type: script-check
    checks: [backend-impl]
    checkout: ${checkout}
    scripts:
${list}
edges:
  - planner -> backend-impl: start, feedback, accept
  - backend-impl -> planner: report
  - planner -> ci: start
  - ci -> planner: report
` };
  return resolvePipelineDefinition("cuck-ci", catalog);
}

let root, linesDir, src, router, base, seq = 0;
const lines = {};
const call = async (method, pathname, body) => {
  const res = await fetch(base + pathname, { method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* plain text */ }
  return { status: res.status, body: parsed, text };
};

// Seeds a line with one completed implementor "impl" (id i1). Returns its paths.
function seedLine(scripts, checkout, { workers = [] } = {}) {
  const id = `ck-${++seq}`;
  const lineDir = path.join(linesDir, id);
  const clone = path.join(lineDir, "repos", "api");
  fs.mkdirSync(lineDir, { recursive: true });
  execFileSync("git", ["clone", "-q", src, clone]);
  const worktree = path.join(linesDir, "worktrees", id, "api", "impl");
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(clone, "worktree", "add", "-q", "--detach", worktree);
  const baseCommit = git(src, "rev-parse", "HEAD");
  const impl = { id: "i1", name: "impl", node: "backend-impl", persona: "backend", role: "implementor",
    status: "completed", repo: "api", branch: "b/impl", runGeneration: 1, lastCompletedInvocationId: "inv-1",
    lastRunText: "report of impl", baseCommit, worktreePath: worktree };
  fs.writeFileSync(path.join(lineDir, "line.json"), JSON.stringify({ id, name: id, layout: 2,
    started: true, planApproved: true, graph: graphWith(scripts, checkout),
    repos: [{ name: "api", url: src, path: clone }], workers: [impl, ...workers] }));
  return { id, lineDir, clone, worktree };
}

const start = (line) => call("POST", `/api/protocol/lines/${line.id}/interactions/start`, { to: "ci", source: "i1" });
// The persisted worker record: the router saves it at every step and at the end.
const checkWorker = async (line) => JSON.parse(fs.readFileSync(path.join(line.lineDir, "line.json"), "utf8"))
  .workers.find((w) => w.runner === "script");

async function until(fn, message) {
  for (let i = 0; i < 400; i++) {
    const value = await fn();
    if (value) return value;
    await wait(25);
  }
  throw new Error(`timeout: ${message}`);
}
const settled = (line) => until(async () => {
  const w = await checkWorker(line);
  return w && w.status !== "running" ? w : null;
}, "the check ends");

// The text of every planner request of a line, queued or active.
function plannerText(line) {
  const meta = JSON.parse(fs.readFileSync(path.join(line.lineDir, "line.json"), "utf8"));
  return JSON.stringify([meta.activePlannerRequest, ...(meta.plannerQueue || [])]);
}
const reportOf = (line) => until(() => {
  const text = plannerText(line);
  return text.includes("FINAL VERDICT") ? text : null;
}, "the report reaches the planner");
const treeList = (line) => git(line.clone, "worktree", "list");

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "script-check-server-"));
  linesDir = path.join(root, "lines");
  fs.mkdirSync(linesDir);
  src = path.join(root, "src");
  fs.mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(src, "a.txt"), "a");
  git(src, "add", ".");
  git(src, "commit", "-qm", "init");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  for (const agent of ["claude", "vibe", "codex", "pi"]) {
    fs.writeFileSync(path.join(bin, agent), "#!/bin/sh\nexec sleep 60\n");
    fs.chmodSync(path.join(bin, agent), 0o755);
  }
  // Lines load at boot: seed them all before the router starts.
  lines.pass = seedLine([["pwd", "pwd"], ["ok", "exit 0"]], "worktree");
  lines.fail = seedLine([["bad", "echo broken; exit 1"]], "worktree");
  lines.changeset = seedLine([["ok", "exit 0"]], "worktree");
  lines.stop = seedLine([["slow", "sleep 5"]], "worktree");
  lines.clean = seedLine([["pwd", "pwd"], ["head", "git rev-parse HEAD"]], "clean");
  lines.cleanStop = seedLine([["slow", "sleep 5"]], "clean");
  router = await startRouter(linesDir, { ROUTER_ALLOW_LOCAL_REPOS: "1", PATH: `${bin}:${process.env.PATH}` });
  base = router.base;
});

test.after(async () => {
  if (router) await stopRouter(router);
  fs.rmSync(root, { recursive: true, force: true });
});

test("start creates check-<name>; a pass reaches the planner and feeds the integration selection", { timeout: 30_000 }, async () => {
  const line = lines.pass;
  const out = await start(line);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const worker = await checkWorker(line);
  assert.equal(worker.name, "check-impl");
  assert.equal(worker.runner, "script");
  const text = await reportOf(line);
  assert.match(text, /CHECK REPORT/);
  assert.match(text, /FINAL VERDICT: PASS/);
  const done = await settled(line);
  assert.equal(done.status, "completed");
  assert.equal(done.checkResults.length, 2);
  // checkout worktree: the first script ran in the implementor worktree.
  const log = await call("GET", `/api/protocol/workers/${worker.id}/check-log?step=0`);
  assert.equal(log.status, 200);
  assert.equal(fs.realpathSync(log.text.trim()), fs.realpathSync(line.worktree));
  // A PASS on the current run puts the implementor in the integration selection:
  // a second start only gets the accepted-work check, not a blocker for 'impl'.
  const integration = await call("POST", `/api/protocol/lines/${line.id}/interactions/start`, { to: "integration" });
  assert.doesNotMatch(JSON.stringify(integration.body), /awaiting-criteria|verdict-/);
  // feedback to the check worker is refused.
  const feedback = await call("POST", `/api/protocol/lines/${line.id}/interactions/feedback`,
    { instance: worker.id, instructions: "again" });
  assert.ok([403, 409].includes(feedback.status), `feedback status ${feedback.status}`);
});

test("a failing script gives FINAL VERDICT: FAIL; the log route rejects bad requests", { timeout: 30_000 }, async () => {
  const line = lines.fail;
  assert.equal((await start(line)).status, 201);
  assert.match(await reportOf(line), /FINAL VERDICT: FAIL/);
  const worker = await settled(line);
  const url = (query) => `/api/protocol/workers/${worker.id}/check-log${query}`;
  assert.match((await call("GET", url("?step=0"))).text, /broken/);
  assert.equal((await call("GET", url("?step=../x"))).status, 400);
  assert.equal((await call("GET", url("?step=-1"))).status, 400);
  assert.equal((await call("GET", url(""))).status, 400);
  assert.equal((await call("GET", url("?step=7"))).status, 404);
  assert.equal((await call("GET", `/api/protocol/workers/i1/check-log?step=0`)).status, 404);
  assert.equal((await call("GET", `/api/protocol/workers/nope/check-log?step=0`)).status, 404);
});

test("the implementor change set block does not run for a script worker", { timeout: 30_000 }, async () => {
  const line = lines.changeset;
  assert.equal((await start(line)).status, 201);
  await reportOf(line);
  const meta = JSON.parse(fs.readFileSync(path.join(line.lineDir, "line.json"), "utf8"));
  const check = meta.workers.find((w) => w.runner === "script");
  assert.equal(check.status, "completed");
  assert.equal(check.changeset, null);
});

test("stop ends the check as stopped", { timeout: 30_000 }, async () => {
  const line = lines.stop;
  assert.equal((await start(line)).status, 201);
  const worker = await checkWorker(line);
  await wait(300);
  assert.equal((await call("POST", `/api/protocol/workers/${worker.id}/stop`)).status, 202);
  assert.equal((await settled(line)).status, "stopped");
});

test("checkout clean runs in a detached tree at the checked commit and removes it", { timeout: 30_000 }, async () => {
  const line = lines.clean;
  assert.equal((await start(line)).status, 201);
  const worker = await checkWorker(line);
  await reportOf(line);
  await settled(line);
  const tree = path.join(line.lineDir, "checks", worker.id, "run-1", "tree");
  const log0 = await call("GET", `/api/protocol/workers/${worker.id}/check-log?step=0`);
  const log1 = await call("GET", `/api/protocol/workers/${worker.id}/check-log?step=1`);
  // The tree is gone after the run: compare with the real path of the line folder.
  assert.equal(log0.text.trim(), path.join(fs.realpathSync(line.lineDir), "checks", worker.id, "run-1", "tree"));
  assert.equal(log1.text.trim(), git(line.worktree, "rev-parse", "HEAD"));
  await until(() => !fs.existsSync(tree) && !treeList(line).includes("/checks/"), "the tree is removed");
});

test("a stop removes the clean tree; remove deletes the check folder", { timeout: 30_000 }, async () => {
  const line = lines.cleanStop;
  assert.equal((await start(line)).status, 201);
  const worker = await checkWorker(line);
  const tree = path.join(line.lineDir, "checks", worker.id, "run-1", "tree");
  await until(() => fs.existsSync(tree), "the tree exists");
  assert.equal((await call("POST", `/api/protocol/workers/${worker.id}/stop`)).status, 202);
  assert.equal((await settled(line)).status, "stopped");
  await until(() => !fs.existsSync(tree) && !treeList(line).includes("/checks/"), "the tree is removed");
  assert.ok(fs.existsSync(path.join(line.lineDir, "checks", worker.id)));
  assert.equal((await call("POST", `/api/protocol/workers/${worker.id}/remove`)).status, 200);
  assert.ok(!fs.existsSync(path.join(line.lineDir, "checks", worker.id)));
});

test("the boot sweep marks a running script worker as stopped", { timeout: 30_000 }, async (t) => {
  const seeded = seedLine([["ok", "exit 0"]], "worktree");
  const meta = JSON.parse(fs.readFileSync(path.join(seeded.lineDir, "line.json"), "utf8"));
  meta.workers.push({ id: "c1", name: "check-impl", node: "ci", role: "validator", validates: "i1",
    runner: "script", harness: "script", status: "running", repo: "api", branch: "b/impl",
    worktreePath: seeded.worktree, checkResults: [], scriptSpec: { steps: [], failFast: true, checkout: "worktree" } });
  const rebootDir = path.join(root, "reboot");
  fs.mkdirSync(path.join(rebootDir, seeded.id), { recursive: true });
  fs.writeFileSync(path.join(rebootDir, seeded.id, "line.json"), JSON.stringify(meta));
  const second = await startRouter(rebootDir, { ROUTER_ALLOW_LOCAL_REPOS: "1" });
  t.after(() => stopRouter(second));
  // The snapshot of the event stream holds one state event per line.
  const events = await fetch(second.base + "/api/events");
  t.after(() => events.body.cancel());
  let body = "";
  for await (const chunk of events.body) {
    body += Buffer.from(chunk).toString();
    if (body.includes('"type":"snapshot_end"')) break;
  }
  const states = [...body.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1])).filter((e) => e.type === "state");
  const worker = states.map((e) => e.data).find((d) => d.id === seeded.id).workers.find((w) => w.id === "c1");
  assert.equal(worker.status, "stopped");
  assert.equal(worker.runner, "script");
});
