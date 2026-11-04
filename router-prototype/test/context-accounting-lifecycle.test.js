"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFakeChild } = require("./fixtures/planner-child");
const { loadBuiltinPipeline } = require("../line-graph");
const { contextView, shouldAutoCompact } = require("../compaction");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-lifecycle-"));
process.env.LINES_DIR = root;
process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
process.env.PATH = root;
const server = require("../server");
after(() => fs.rmSync(root, { recursive: true, force: true }));

function line() {
  const workdir = fs.mkdtempSync(path.join(root, "line-"));
  return { id: path.basename(workdir), name: "context test", workdir,
    status: "idle", deleted: false, compacting: false, started: true, planApproved: true,
    queue: [], transcript: [], workers: new Map(), clients: new Set(), inventory: new Map(),
    repos: new Map(), pendingValidations: [], sessionId: null, sessionCfg: null, context: null,
    graph: loadBuiltinPipeline("default", fs, path.join(__dirname, "..")),
    nodeSettings: { planner: { harness: "claude", maxContext: 200000 } } };
}

function writeUsage(env, workdir, sessionId, usage) {
  const file = path.join(env.CLAUDE_CONFIG_DIR, "projects",
    workdir.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: "assistant", sessionId,
    message: { role: "assistant", usage } }) + "\n");
}

function stream(child, sessionId, usage) {
  child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\n");
  child.stdout.write(JSON.stringify({ type: "assistant", session_id: sessionId,
    message: { role: "assistant", content: [{ type: "text", text: "Done." }], usage } }) + "\n");
  child.stdout.write(JSON.stringify({ type: "result", is_error: false,
    usage: { input_tokens: 900000, output_tokens: 9000 } }) + "\n");
}

for (const initial of [0, 100]) {
  test(`planner completion uses saved final usage instead of ${initial} streamed tokens`, t => {
    const item = line();
    const child = createFakeChild();
    let invocation;
    server.setSpawnForTest((cmd, args, options) => { invocation = options; return child; });
    item.queue.push({ id: "request", text: "Check status", recorded: true });
    server.pump(item);
    const sessionId = "planner-session";
    stream(child, sessionId, { input_tokens: initial, output_tokens: 0 });
    writeUsage(invocation.env, invocation.cwd, sessionId, { input_tokens: 229407, output_tokens: 1421 });
    const oldConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(root, "wrong-config");
    try { child.emitClose(0); } finally { process.env.CLAUDE_CONFIG_DIR = oldConfig; }
    assert.equal(item.context.tokens, 230828);
    assert.equal(contextView(item.context, 200000).estimated, false);
    assert.equal(shouldAutoCompact(item.context, 200000), true);
  });
}

test("planner retains streamed usage when its session file is unavailable", t => {
  const item = line();
  const child = createFakeChild();
  server.setSpawnForTest(() => child);
  item.queue.push({ id: "request", text: "Check status", recorded: true });
  server.pump(item);
  stream(child, "missing-session", { input_tokens: 5000, cache_read_input_tokens: 1000, output_tokens: 100 });
  child.emitClose(0);
  assert.equal(item.context.tokens, 6100);
});

test("implementor completion reads its own worktree session rather than the planner's", t => {
  const item = line();
  const child = createFakeChild();
  const worktreePath = path.join(root, "worker-worktree");
  fs.mkdirSync(worktreePath);
  const worker = { id: "worker-context", name: "worker", role: "implementor", overrides: { harness: "claude" },
    status: "running", worktreePath, prompt: "Work", transcript: [], sessionId: null };
  item.workers.set(worker.id, worker);
  let invocation;
  server.setSpawnForTest((cmd, args, options) => { invocation = options; return child; });
  server.spawnWorker(item, worker, worker.prompt, false);
  assert.equal(invocation.cwd, worktreePath);
  stream(child, "worker-session", { input_tokens: 100, output_tokens: 0 });
  writeUsage(invocation.env, item.workdir, "worker-session", { input_tokens: 999999 });
  writeUsage(invocation.env, worktreePath, "worker-session", { input_tokens: 229407, output_tokens: 1421 });
  item.deleted = true;
  child.emitClose(0);
  assert.equal(worker.context.tokens, 230828);
  assert.equal(contextView(worker.context, 200000).estimated, false);
});
