"use strict";

// Live settings: new pipeline settings apply to the next run of every node.
// Runs in process with fake child processes; no agent CLI starts.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFakeChild } = require("./fixtures/planner-child");
const { loadBuiltinPipeline } = require("../line-graph");
const { resolveWorkerOverrides } = require("../spawn-plan");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-settings-"));
const LEGACY_LINE = "legacy-line";
const LEGACY_WORKER = "legacy-worker";
process.env.LINES_DIR = root;
process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
process.env.PATH = root;
// A legacy line.json: its worker has harness, model and effort but no overrides.
const legacyDir = path.join(root, LEGACY_LINE);
fs.mkdirSync(path.join(legacyDir, "workdir"), { recursive: true });
fs.writeFileSync(path.join(legacyDir, "line.json"), JSON.stringify({ id: LEGACY_LINE, name: "legacy",
  started: true, planApproved: true, status: "idle", workers: [{ id: LEGACY_WORKER, name: "old",
    role: "implementor", node: "backend-impl", status: "completed", branch: "b/old",
    prompt: "brief", sessionId: "old-session", harness: "claude", model: "old-model", effort: "low",
    worktreePath: root }] }));
const server = require("../server");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const graph = () => loadBuiltinPipeline("default", fs, path.join(__dirname, ".."));
function line(nodeSettings) {
  const workdir = fs.mkdtempSync(path.join(root, "line-"));
  return { id: path.basename(workdir), name: "live", workdir, status: "idle", deleted: false,
    compacting: false, started: true, planApproved: true, queue: [], transcript: [],
    workers: new Map(), clients: new Set(), inventory: new Map(), repos: new Map(),
    pendingValidations: [], sessionId: null, sessionCfg: null, context: null,
    graph: graph(), nodeSettings };
}
function worker(item, extra = {}) {
  const w = { id: "w-" + item.workers.size, name: "impl", role: "implementor", node: "backend-impl",
    kind: "standard", status: "completed", worktreePath: root, prompt: "brief", transcript: [],
    sessionId: "S-old", harness: "claude", model: "m-old", effort: "low", handoff: null,
    overrides: { harness: null, model: null, effort: null }, runGeneration: 1, ...extra };
  item.workers.set(w.id, w);
  return w;
}
// Records each spawn; each fake child answers with a result and closes at once.
function recordSpawns(summary = "S".repeat(60)) {
  const calls = [];
  server.setSpawnForTest((cmd, args) => {
    const child = createFakeChild();
    calls.push({ cmd, args, child });
    setImmediate(() => {
      const sid = "session-" + calls.length;
      child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sid }) + "\n");
      child.stdout.write(JSON.stringify({ type: "assistant", session_id: sid,
        message: { role: "assistant", content: [{ type: "text", text: summary }] } }) + "\n");
      child.stdout.write(JSON.stringify({ type: "result", is_error: false, result: summary }) + "\n");
      child.emitClose(0);
    });
    return child;
  });
  return calls;
}
const flag = (args, name) => args[args.indexOf(name) + 1];
const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(fn(), "timeout"); };

test("a: a changed model and effort apply to the next continuation of a worker", async () => {
  const item = line({ "backend-impl": { harness: "claude", model: "m-old", effort: "low" } });
  const w = worker(item);
  const calls = recordSpawns();
  item.nodeSettings = { "backend-impl": { harness: "claude", model: "m-new", effort: "high" } };
  assert.equal(server.deliverToInstance(item, w, "more").ok, true);
  await until(() => w.status !== "running" && calls.length > 0);
  assert.equal(calls[0].cmd, "claude");
  assert.equal(flag(calls[0].args, "--model"), "m-new");
  assert.equal(flag(calls[0].args, "--effort"), "high");
  assert.equal(w.model, "m-new");
  assert.equal(w.effort, "high");
});

test("b: a changed harness compacts on the old harness and continues in a fresh session", async () => {
  const item = line({ "backend-impl": { harness: "codex", model: "m-codex", effort: "high" } });
  const w = worker(item);
  const calls = recordSpawns();
  server.deliverToInstance(item, w, "more");
  await until(() => calls.length >= 2 && w.status !== "running");
  assert.equal(calls[0].cmd, "claude", "compaction runs on the old harness");
  assert.ok(calls[0].args.includes("S-old"), "the summary turn resumes the old session");
  assert.equal(flag(calls[0].args, "--model"), "m-old");
  assert.equal(calls[1].cmd, "codex", "the continuation runs on the new harness");
  assert.equal(calls[1].args.includes("S-old"), false, "fresh session, no resume");
  assert.equal(w.harness, "codex");
  assert.notEqual(w.sessionId, "S-old");
});

test("b2: a failed compaction clears the session and leaves a handoff note", async () => {
  const item = line({ "backend-impl": { harness: "codex", model: "m-codex", effort: "high" } });
  const w = worker(item);
  const calls = [];
  server.setSpawnForTest((cmd, args) => {
    const child = createFakeChild();
    calls.push({ cmd, args });
    setImmediate(() => child.emitClose(cmd === "claude" ? 1 : 0));
    return child;
  });
  server.deliverToInstance(item, w, "more");
  await until(() => calls.length >= 2);
  assert.equal(calls[1].cmd, "codex");
  assert.equal(calls[1].args.includes("S-old"), false);
  assert.match(w.handoff || "", /No summary is available/);
});

test("c: an explicit per-worker override survives a pipeline change", async () => {
  const item = line({ "backend-impl": { harness: "claude", model: "m-new", effort: "high" } });
  const w = worker(item, { overrides: { harness: "claude", model: "m-pinned", effort: "medium" },
    model: "m-pinned", effort: "medium" });
  const calls = recordSpawns();
  server.deliverToInstance(item, w, "more");
  await until(() => calls.length > 0);
  assert.equal(flag(calls[0].args, "--model"), "m-pinned");
  assert.equal(flag(calls[0].args, "--effort"), "medium");
});

test("d: planner settings changed while idle apply to the next prompt", async () => {
  const item = line({ planner: { harness: "claude", model: "m-first" } });
  const calls = recordSpawns();
  item.nodeSettings = { planner: { harness: "claude", model: "m-second" } };
  item.queue.push({ id: "r1", text: "Hello", recorded: true });
  server.pump(item);
  await until(() => calls.length > 0);
  assert.equal(flag(calls[0].args, "--model"), "m-second");
});

test("e: a planner spawn that throws sets failed, keeps the request and sends status", async () => {
  const item = line({ planner: { harness: "claude" } });
  const events = [];
  item.clients.add({ write: (chunk) => events.push(String(chunk)), end() {}, on() {} });
  server.setSpawnForTest(() => { throw new Error("spawn exploded"); });
  item.queue.push({ id: "r1", text: "Hello", recorded: true });
  server.pump(item);
  assert.equal(item.status, "failed");
  assert.match(item.lastError, /spawn exploded/);
  assert.equal(item.queue.length, 1);
  assert.equal(item.queue[0].text, "Hello");
  assert.equal(item.activePlannerRequest, null);
  assert.equal(item.activePlannerRun, null);
  assert.equal(item.child, null);
  assert.ok(events.some((e) => e.includes("event: state")), "a state event was sent");
  assert.ok(events.some((e) => e.includes("event: status")), "a status event was sent");
  assert.ok(events.some((e) => e.includes("event: error")), "an error event was sent");
  // The next pump (a new prompt) retries the request.
  const calls = recordSpawns();
  server.pump(item);
  assert.equal(calls.length, 1);
  await until(() => item.status !== "running");
});

test("e2: a new user prompt after a planner start failure starts a new run", async () => {
  const item = line({ planner: { harness: "claude" } });
  server.setSpawnForTest(() => { throw new Error("spawn exploded"); });
  item.queue.push({ id: "r1", text: "First", recorded: true });
  server.pump(item);
  assert.equal(item.status, "failed");
  const calls = recordSpawns();
  item.queue.push({ id: "r2", text: "Second", recorded: true });
  server.pump(item);
  assert.equal(calls.length, 1, "a new run started");
  assert.ok(calls[0].args.some((a) => String(a).includes("First")), "the kept request runs first");
  await until(() => item.status !== "running");
});

test("f: a throw in the close handler does not leave the status running", () => {
  const item = line({ planner: { harness: "claude" } });
  const child = createFakeChild();
  server.setSpawnForTest(() => child);
  item.queue.push({ id: "r1", text: "Hello", recorded: true });
  server.pump(item);
  assert.equal(item.status, "running");
  // From here every save throws: the close handler path fails.
  let armed = true;
  server.setLifecycleHooksForTest({ save: () => { if (armed) throw new Error("save broke"); } });
  try {
    child.emitClose(0);
  } finally { armed = false; server.setLifecycleHooksForTest(null); }
  assert.notEqual(item.status, "running");
  assert.equal(item.status, "failed");
  assert.match(item.lastError, /close handling failed/);
});

test("g: a legacy worker without overrides follows the new pipeline settings", async () => {
  // Lines that earlier tests saved load too; their queued requests spawn fake children that close.
  const calls = recordSpawns();
  server.loadLines();
  const item = server.lines.get(LEGACY_LINE);
  assert.ok(item, "the legacy line loaded");
  const w = item.workers.get(LEGACY_WORKER);
  assert.deepEqual(w.overrides, { harness: null, model: null, effort: null });
  const cfg = { harness: "claude", model: "m-fresh", effort: "high" };
  assert.deepEqual(resolveWorkerOverrides(cfg, w, "implementor"), cfg);
  item.nodeSettings = { "backend-impl": cfg };
  server.deliverToInstance(item, w, "more");
  await until(() => calls.some((c) => c.args.includes("m-fresh")));
  const call = calls.find((c) => c.args.includes("m-fresh"));
  assert.equal(flag(call.args, "--effort"), "high");
});

test("resolveWorkerOverrides reads only worker.overrides", () => {
  const cfg = { harness: "claude", model: "m", effort: "low" };
  const w = { harness: "codex", model: "x", effort: "high" };
  assert.deepEqual(resolveWorkerOverrides(cfg, w, "implementor"), cfg);
  w.overrides = { harness: null, model: "pin", effort: null };
  assert.deepEqual(resolveWorkerOverrides(cfg, w, "implementor"), { ...cfg, model: "pin" });
});
