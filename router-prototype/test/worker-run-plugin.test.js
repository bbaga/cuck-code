"use strict";

// The worker run goes through the plugin runner. A fake in-memory plugin
// stands in for the harness, so no process starts.

const { test, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadBuiltinPipeline } = require("../line-graph");
const { registerHarness, unregisterPluginHarnesses } = require("../harness-registry");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-run-plugin-"));
process.env.LINES_DIR = root;
const server = require("../server");
after(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => unregisterPluginHarnesses());

// onRun(sink, request, kind) returns the RunResult fields; the run settles
// on the next tick. kind is "start" or "resume".
function register(id, onRun) {
  const calls = [];
  const run = (kind, request, sink) => {
    // A closed worker wakes the planner; only worker phases count here.
    if (request.phase !== "planner") calls.push({ kind, request });
    const result = onRun(sink, request, kind);
    const done = new Promise((resolve) => setImmediate(() => resolve({ exitCode: 0,
      signal: null, command: "fake", spawnError: null, stderr: null, ...result })));
    return { stop: () => true, done };
  };
  registerHarness({
    apiVersion: 1, id,
    capabilities: { resume: true, systemPrompt: "none", nativeTimeLimit: true, providers: false },
    async probe() { return { installed: true, version: null, auth: "ok", loginHint: "" }; },
    async listModels() { return []; },
    startSession: (ctx, request, sink) => run("start", request, sink),
    resumeSession: (ctx, request, sink) => run("resume", request, sink),
  }, { layer: "user", folder: `/tmp/${id}` });
  return calls;
}

function setup(harness) {
  const workdir = fs.mkdtempSync(path.join(root, "line-"));
  const line = { id: path.basename(workdir), name: "worker plugin", workdir,
    status: "idle", deleted: false, compacting: false, started: true, planApproved: true,
    queue: [], transcript: [], workers: new Map(), clients: new Set(), inventory: new Map(),
    repos: new Map(), pendingValidations: [], sessionId: null, sessionCfg: null, context: null,
    graph: loadBuiltinPipeline("default", fs, path.join(__dirname, "..")),
    nodeSettings: { planner: { harness }, implementor: { harness } } };
  const worker = { id: "w1", name: "worker", role: "implementor", status: "running",
    overrides: { harness }, worktreePath: workdir, prompt: "Work", transcript: [],
    sessionId: null };
  line.workers.set(worker.id, worker);
  return { line, worker };
}

function until(check) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (check()) { clearInterval(timer); resolve(); }
    }, 5);
  });
}

const settled = (worker) => () => worker.child === null && worker.status !== "running";

test("a plugin worker completes and its assistant text is the report", async () => {
  const calls = register("fake-worker-ok", (sink) => {
    sink.session("worker-session");
    sink.entry({ role: "assistant", text: "all done" });
    return { outcome: "ok" };
  });
  const { line, worker } = setup("fake-worker-ok");
  server.spawnWorker(line, worker, worker.prompt, false);
  assert.equal(typeof worker.child.kill, "function");
  await until(settled(worker));
  assert.equal(worker.status, "completed");
  assert.equal(worker.sessionId, "worker-session");
  assert.equal(calls[0].kind, "start");
  assert.ok(worker.transcript.some((e) => e.text === "all done"
    && e.sessionId === "worker-session"));
});

test("feedback resumes the plugin worker with the same session id", async () => {
  const calls = register("fake-worker-resume", (sink) => {
    sink.session("resume-session");
    sink.entry({ role: "assistant", text: "turn" });
    return { outcome: "ok" };
  });
  const { line, worker } = setup("fake-worker-resume");
  server.spawnWorker(line, worker, worker.prompt, false);
  await until(settled(worker));
  worker.status = "running";
  server.spawnWorker(line, worker, "please fix", true);
  await until(settled(worker));
  assert.deepEqual(calls.map((c) => c.kind), ["start", "resume"]);
  assert.equal(calls[1].request.sessionId, "resume-session");
});

test("a timeout outcome from the plugin run ends the worker as timed out", async () => {
  register("fake-worker-timeout", () => ({ outcome: "timeout", signal: "SIGTERM", exitCode: null }));
  const { line, worker } = setup("fake-worker-timeout");
  server.spawnWorker(line, worker, worker.prompt, false);
  await until(settled(worker));
  assert.notEqual(worker.status, "completed");
  assert.match(worker.lastError, /time/i);
});

test("a synchronous plugin throw fails the worker with a start message", async () => {
  register("fake-worker-throw", () => { throw new Error("no binary"); });
  const { line, worker } = setup("fake-worker-throw");
  server.spawnWorker(line, worker, worker.prompt, false);
  assert.equal(worker.child, null);
  assert.match(worker.lastError, /The worker run could not start\. no binary/);
  assert.notEqual(worker.status, "running");
});
