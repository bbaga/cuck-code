"use strict";

// One full run of the built-in pipeline "example-choreographed" in one process.
// Fake child processes stand for the agents. The planner never starts: its request stays queued.
// The script check runs a real shell command in a small temporary git repo (no fake script result).

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createFakeChild } = require("./fixtures/planner-child");
const { loadBuiltinPipeline } = require("../line-graph");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "example-pipeline-"));
const reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "example-pipeline-repos-"));
process.env.LINES_DIR = root;
const server = require("../server");
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(reposRoot, { recursive: true, force: true });
});

const git = (cwd, ...args) => execFileSync("git",
  ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
const PASS = "Checked.\nVERDICT: PASS";
const FAIL = "Found a problem.\nVERDICT: FAIL";
const INSTRUCTIONS = "Merge the batch and run the full suite.";
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function until(predicate, what) {
  for (let i = 0; i < 400 && !predicate(); i++) await sleep(25);
  assert.ok(predicate(), what);
}

async function post(line, name, body) {
  const srv = server.createServer();
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  try {
    return await new Promise((ok, fail) => {
      const req = http.request({ host: "127.0.0.1", port: srv.address().port, method: "POST",
        path: `/api/protocol/lines/${line}/interactions/${name}`, headers: { "Content-Type": "application/json" } },
      (res) => { let text = ""; res.on("data", (c) => { text += c; });
        res.on("end", () => ok({ status: res.statusCode, text })); });
      req.on("error", fail);
      req.end(JSON.stringify(body));
    });
  } finally {
    await new Promise((ok) => srv.close(ok));
  }
}

// The example pipeline. The script of backend-lint fails on its first run only. It writes
// CUCK_BASE_COMMIT to a file first, then it ends with the real command of the example.
function lintGraph(envFile, marker) {
  const graph = loadBuiltinPipeline("example-choreographed", fs, path.join(__dirname, ".."));
  const script = graph.nodes["backend-lint"].scripts[0];
  script.run = `printf %s "$CUCK_BASE_COMMIT" > '${envFile}'; ` +
    `if [ ! -f '${marker}' ]; then touch '${marker}'; exit 1; fi; ${script.run}`;
  return graph;
}

function rig() {
  const id = "example-1";
  const dir = path.join(reposRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  const base = git(dir, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "work.js"), "// work\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "work");
  const workdir = path.join(root, id);
  fs.mkdirSync(workdir);
  const envFile = path.join(reposRoot, "base-commit.txt");
  const item = { id, name: id, workdir, status: "running", activePlannerRequest: { id: "busy", text: "busy" },
    deleted: false, compacting: false, started: true, planApproved: true, queue: [], transcript: [],
    workers: new Map(), clients: new Set(), inventory: new Map(),
    repos: new Map([["api", { name: "api", url: dir, path: dir }]]), pendingValidations: [], sessionId: null,
    sessionCfg: null, context: null, nodeSettings: {}, pendingHandoffs: [],
    graph: lintGraph(envFile, path.join(reposRoot, "lint-marker")) };
  const head = (node, persona, name) => {
    git(dir, "branch", `b/${name}`);
    const w = { id: `${id}-${name}`, name, role: "implementor", node, persona, kind: "standard", repo: "api",
      branch: `b/${name}`, harness: "vibe", status: "running", stopRequested: false, baseCommit: base,
      worktreePath: dir, prompt: "Work.", transcript: [], sessionId: null, runGeneration: 1,
      chainFields: { criteria: `Check the ${name} work.` }, reworkRounds: {}, stage: null };
    item.workers.set(w.id, w);
    return w;
  };
  const heads = { backend: head("backend-impl", "backend", "api-task"), frontend: head("frontend-impl", "frontend", "web-task") };
  server.lines.set(id, item);
  const spawned = [];
  server.setSpawnForTest((cmd, args) => {
    const child = createFakeChild();
    spawned.push({ child, args: JSON.stringify(args), ended: false });
    return child;
  });
  const endNext = (text) => {
    const next = spawned.find((s) => !s.ended);
    next.ended = true;
    next.child.stdout.write(JSON.stringify({ type: "message", role: "assistant", sessionId: "s-1",
      content: [{ type: "text", text }] }) + "\n");
    next.child.emitClose(0);
  };
  const scripts = () => [...item.workers.values()].filter((w) => w.runner === "script");
  const reworks = () => spawned.filter((s) => s.args.includes("REWORK REQUEST"));
  return { item, heads, spawned, endNext, scripts, reworks, base, envFile, texts: () => item.queue.map((r) => r.text) };
}

test("example-choreographed: two tasks, one combined rework each, the batch and integration, no planner wake", async () => {
  const r = rig();
  // The tasks are the chain heads of the line (their start calls need a real clone). Start the batch by the API.
  const started = await post(r.item.id, "start", { to: "batch", members: "api-task,web-task", instructions: INSTRUCTIONS });
  assert.equal(started.status, 201, started.text);
  const wait = [...r.item.workers.values()].find((w) => w.runner === "wait");

  // Backend run 1: backend-val and backend-lint start together. The lint fails, the validator passes.
  server.spawnWorker(r.item, r.heads.backend, "Work.", false);
  r.endNext("Did the backend work.");
  assert.deepEqual(Object.keys(r.heads.backend.stage.members).sort(), ["backend-lint", "backend-val"]);
  assert.equal(r.scripts().length, 1, "the script check runs on the same backend run");
  r.endNext(PASS);
  await until(() => r.reworks().length === 1, "one combined rework to backend-impl");
  assert.equal(r.reworks().length, 1);
  assert.match(r.reworks()[0].args, /backend-lint/);
  assert.deepEqual(r.heads.backend.reworkRounds, { "backend-impl": 1 });
  assert.deepEqual(r.texts(), [], "no planner wake after the rework");
  assert.equal(fs.readFileSync(r.envFile, "utf8"), r.base, "backend-lint gets CUCK_BASE_COMMIT");

  // Backend run 2: both checkers pass and the task arrives at the batch.
  r.endNext("Fixed the backend work.");
  r.endNext(PASS);
  await until(() => r.scripts().length === 2 && r.scripts().every((s) => s.status !== "running"), "the second lint ends");
  assert.equal(r.scripts()[1].verdict, "pass");
  assert.equal(r.reworks().length, 1, "no second rework");
  assert.equal(wait.arrivals[r.heads.backend.id].runGeneration, 2);
  assert.equal(wait.status, "running", "the frontend task has not arrived");

  // Frontend: frontend-val fails one time, then passes, and the task arrives.
  server.spawnWorker(r.item, r.heads.frontend, "Work.", false);
  r.endNext("Did the frontend work.");
  r.endNext(FAIL);
  assert.equal(r.reworks().length, 2, "one rework to frontend-impl");
  assert.deepEqual(r.heads.frontend.reworkRounds, { "frontend-impl": 1 });
  assert.deepEqual(r.texts(), [], "no planner wake after the frontend rework");
  r.endNext("Fixed the frontend work.");
  r.endNext(PASS);

  // The batch completes and integration starts one time with the instructions of the batch start call.
  assert.equal(wait.status, "completed");
  const integrations = [...r.item.workers.values()].filter((w) => w.kind === "integration");
  assert.equal(integrations.length, 1, "integration starts one time");
  assert.match(integrations[0].prompt, new RegExp(INSTRUCTIONS));
  assert.deepEqual(r.texts(), [], "no per-task and no per-checker report reached the planner");
});
