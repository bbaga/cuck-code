"use strict";

// compactPlanner runs its summary turn through the plugin runner. A fake
// in-memory plugin stands in for the harness, so no process starts.

const { test, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadBuiltinPipeline } = require("../line-graph");
const { registerHarness, unregisterPluginHarnesses } = require("../harness-registry");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-runner-"));
process.env.LINES_DIR = root;
const server = require("../server");
after(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => unregisterPluginHarnesses());

const SUMMARY = "Goal: add login. Done: API route. Next: UI form. Branch line/x.";

function fakePlugin(id, onStart) {
  const requests = [];
  return {
    requests,
    plugin: {
      apiVersion: 1, id,
      capabilities: { resume: true, systemPrompt: "none", nativeTimeLimit: true, providers: false },
      async probe() { return { installed: true, version: null, auth: "ok", loginHint: "" }; },
      async listModels() { return []; },
      startSession() { throw new Error("compaction must resume the session"); },
      resumeSession(ctx, request, sink) {
        requests.push(request);
        return onStart(sink);
      },
    },
  };
}

function line(harness) {
  const workdir = fs.mkdtempSync(path.join(root, "line-"));
  return { id: path.basename(workdir), name: "compaction runner", workdir,
    status: "idle", deleted: false, compacting: false, started: true, planApproved: true,
    queue: [], transcript: [], workers: new Map(), clients: new Set(), inventory: new Map(),
    repos: new Map(), pendingValidations: [], sessionId: "old-session", sessionCfg: null,
    context: null, child: null,
    graph: loadBuiltinPipeline("default", fs, path.join(__dirname, "..")),
    nodeSettings: { planner: { harness, maxContext: 200000 } } };
}

function settle(item) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!item.compacting) { clearInterval(timer); resolve(); }
    }, 5);
  });
}

test("a plugin summary becomes the planner handoff", async () => {
  const fake = fakePlugin("fake-ok", (sink) => {
    sink.session("summary-session");
    sink.entry({ role: "assistant", text: SUMMARY });
    return { stop: () => true, done: Promise.resolve({ outcome: "ok", exitCode: 0,
      signal: null, command: "fake", spawnError: null, stderr: null }) };
  });
  registerHarness(fake.plugin, { layer: "user", folder: "/tmp/fake-ok" });
  const item = line("fake-ok");
  assert.equal(server.compactPlanner(item, "manual"), true);
  assert.equal(typeof item.child.kill, "function");
  await settle(item);
  assert.equal(item.handoff, SUMMARY);
  assert.equal(item.sessionId, null);
  assert.equal(item.child, null);
  assert.equal(fake.requests[0].sessionId, "old-session");
  assert.equal(fake.requests[0].phase, "planner");
});

test("a failing plugin reports the failure text and keeps the session", async () => {
  const fake = fakePlugin("fake-fail", (sink) => {
    sink.error("model overloaded");
    return { stop: () => true, done: Promise.resolve({ outcome: "fail", exitCode: 2,
      signal: null, command: "fake-cli", spawnError: null, stderr: null }) };
  });
  registerHarness(fake.plugin, { layer: "user", folder: "/tmp/fake-fail" });
  const item = line("fake-fail");
  const messages = [];
  item.clients.add({ write: (chunk) => messages.push(String(chunk)), end() {} });
  server.compactPlanner(item, "manual");
  await settle(item);
  assert.equal(item.sessionId, "old-session");
  assert.equal(item.handoff, undefined);
  assert.equal(item.child, null);
  assert.match(messages.join(""), /Context compaction failed.*model overloaded/s);
});
