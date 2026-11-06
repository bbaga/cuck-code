"use strict";

// The planner run goes through the plugin runner. A fake in-memory plugin
// stands in for the harness, so no process starts.

const { test, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadBuiltinPipeline } = require("../line-graph");
const { registerHarness, unregisterPluginHarnesses } = require("../harness-registry");
const { createFakeClock } = require("./fixtures/fake-clock");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "planner-run-plugin-"));
process.env.LINES_DIR = root;
const server = require("../server");
after(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  unregisterPluginHarnesses();
  server.setTimerForTest(null);
});

// start(sink, request, finish) returns the HarnessRun. finish(result) makes
// done resolve with a full RunResult.
function register(id, start, { nativeTimeLimit = true } = {}) {
  const requests = [];
  const plugin = {
    apiVersion: 1, id,
    capabilities: { resume: true, systemPrompt: "none", nativeTimeLimit, providers: false },
    async probe() { return { installed: true, version: null, auth: "ok", loginHint: "" }; },
    async listModels() { return []; },
    startSession: (ctx, request, sink) => run(request, sink),
    resumeSession: (ctx, request, sink) => run(request, sink),
  };
  function run(request, sink) {
    requests.push(request);
    let finish;
    const done = new Promise((resolve) => {
      finish = (result) => resolve({ exitCode: 0, signal: null, command: "fake",
        spawnError: null, stderr: null, ...result });
    });
    return start(sink, finish, request, done);
  }
  registerHarness(plugin, { layer: "user", folder: `/tmp/${id}` });
  return requests;
}

function line(harness) {
  const workdir = fs.mkdtempSync(path.join(root, "line-"));
  return { id: path.basename(workdir), name: "planner plugin", workdir,
    status: "idle", deleted: false, compacting: false, started: true, planApproved: true,
    queue: [{ id: "r1", text: "build it", recorded: true }], transcript: [],
    workers: new Map(), clients: new Set(), inventory: new Map(), repos: new Map(),
    pendingValidations: [], sessionId: null, sessionCfg: null, context: null,
    child: null, activePlannerRun: null, activePlannerRequest: null, runId: null,
    graph: loadBuiltinPipeline("default", fs, path.join(__dirname, "..")),
    nodeSettings: { planner: { harness, maxContext: 200000 } } };
}

function until(check) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (check()) { clearInterval(timer); resolve(); }
    }, 5);
  });
}

test("a plugin planner turn records entries and the session id", async () => {
  const requests = register("fake-planner-ok", (sink, finish, request, done) => {
    sink.session("planner-session");
    sink.entry({ role: "assistant", text: "plan ready" });
    sink.contextTokens(1234);
    finish({ outcome: "ok" });
    return { stop: () => true, done };
  });
  const item = line("fake-planner-ok");
  server.pump(item);
  assert.equal(item.status, "running");
  assert.equal(typeof item.child.kill, "function");
  await until(() => item.status !== "running");
  assert.equal(item.sessionId, "planner-session");
  assert.equal(item.child, null);
  assert.equal(item.activePlannerRun, null);
  assert.ok(item.transcript.some((e) => e.role === "assistant" && e.text === "plan ready"));
  assert.equal(requests[0].phase, "planner");
  assert.equal(item.context.tokens, 1234);
});

test("a stop during a plugin run leaves the status idle", async () => {
  let finishRun;
  register("fake-planner-stop", (sink, finish, request, done) => {
    finishRun = finish;
    return { stop: () => { finish({ outcome: "fail", signal: "SIGTERM", exitCode: null }); return true; },
      done };
  });
  const item = line("fake-planner-stop");
  server.pump(item);
  assert.equal(item.status, "running");
  const result = server.stopPlannerRun(item, item.runId, createFakeClock());
  assert.equal(result.ok, true);
  await until(() => item.status !== "running");
  assert.equal(item.status, "idle");
  assert.equal(typeof finishRun, "function");
});

test("a failing plugin run sets the failed status with the failure text", async () => {
  register("fake-planner-fail", (sink, finish, request, done) => {
    sink.error("model overloaded");
    finish({ outcome: "fail", exitCode: 1, stderr: "boom" });
    return { stop: () => true, done };
  });
  const item = line("fake-planner-fail");
  server.pump(item);
  await until(() => item.status !== "running");
  assert.equal(item.status, "failed");
  assert.match(item.statusDetail || item.lastError || JSON.stringify(item), /model overloaded/);
});

test("the router time limit stops a plugin run without nativeTimeLimit", async () => {
  const clock = createFakeClock();
  server.setTimerForTest(clock);
  const signals = [];
  register("fake-planner-slow", (sink, finish, request, done) => ({
    stop: (signal) => { signals.push(signal); finish({ outcome: "timeout", signal }); return true; },
    done,
  }), { nativeTimeLimit: false });
  const item = line("fake-planner-slow");
  item.nodeSettings.planner.timeLimit = 60;
  server.pump(item);
  assert.deepEqual(signals, []);
  clock.advance(60 * 1000);
  assert.deepEqual(signals, ["SIGTERM"]);
  await until(() => item.status !== "running");
  assert.equal(item.status, "failed");
});
