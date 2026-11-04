"use strict";

// Focused runtime tests for the change-set size policy on the worker
// completion paths (graph and legacy) and the timeout feedback example.
// The fake child process drives spawnWorker without a CLI or a network.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createFakeChild } = require("./fixtures/planner-child");
const { loadBuiltinPipeline } = require("../line-graph");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "changeset-runtime-"));
process.env.LINES_DIR = root;
const server = require("../server");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (cwd, ...args) => execFileSync("git",
  ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
  { encoding: "utf8" }).trim();

// A clean worktree whose committed change set from the base commit holds
// `lines` changed lines (additions plus deletions).
function worktree(name, lines) {
  const wt = path.join(root, name);
  fs.mkdirSync(wt, { recursive: true });
  git(wt, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(wt, "a.txt"), "base\n");
  git(wt, "add", ".");
  git(wt, "commit", "-qm", "base");
  const base = git(wt, "rev-parse", "HEAD");
  if (lines > 0) {
    fs.writeFileSync(path.join(wt, "work.js"),
      Array.from({ length: lines }, (_, i) => `// line ${i + 1}`).join("\n") + "\n");
    git(wt, "add", ".");
    git(wt, "commit", "-qm", "work");
  }
  return { wt, base };
}

function line(graph) {
  const workdir = fs.mkdtempSync(path.join(root, "line-"));
  const item = { id: path.basename(workdir), name: "changeset runtime", workdir,
    status: "idle", deleted: false, compacting: false, started: true, planApproved: true,
    queue: [], transcript: [], workers: new Map(), clients: new Set(), inventory: new Map(),
    repos: new Map(), pendingValidations: [], sessionId: null, sessionCfg: null,
    context: null, nodeSettings: {} };
  if (graph) item.graph = graph;
  return item;
}

function implementor(item, wt, node) {
  const worker = { id: `w-${path.basename(wt.wt)}`, name: "impl", role: "implementor",
    node, persona: "backend", kind: "standard", repo: "api", branch: "b/impl",
    harness: "vibe", status: "running", stopRequested: false,
    baseCommit: wt.base, worktreePath: wt.wt,
    prompt: "Work.", transcript: [], sessionId: null };
  item.workers.set(worker.id, worker);
  return worker;
}

// Run one worker turn: the fake child reports one assistant message and
// closes with `code` (the vibe CLI maps exit code 3 to a timeout). The
// first enqueued wake starts the planner run (lastRun); later wakes wait
// in the queue.
function runWorker(item, worker, code) {
  const child = createFakeChild();
  server.setSpawnForTest(() => child);
  server.spawnWorker(item, worker, worker.prompt, false);
  // Write after the spawn so the router already reads the stream.
  child.stdout.write(JSON.stringify({ type: "message", role: "assistant",
    sessionId: "s-1", content: [{ type: "text", text: "Did the work." }] }) + "\n");
  child.emitClose(code);
  return [item.lastRun, ...item.queue.map((r) => r.text)].filter((t) => typeof t === "string");
}

test("a legacy completion with a clean 501-line change set keeps the full report next to the warning", () => {
  const item = line(null);
  const worker = implementor(item, worktree("big-clean", 501), "unknown-node");
  const texts = runWorker(item, worker, 0);
  const warning = texts.find((t) => t.startsWith("CHANGESET OVERSIZE WARNING"));
  const report = texts.find((t) => t.startsWith("WORKER REPORT"));
  assert.ok(warning, "the planner gets the oversize warning");
  assert.match(warning, /total 501, target 500/);
  assert.ok(report, "the planner also gets the full implementor report");
  assert.match(report, /REPORT BODY \(complete\):\nDid the work\./);
  assert.equal(worker.changeset.oversized, true);
  assert.equal(worker.changeset.ok, true);
});

test("a legacy completion with a small clean change set sends only the report", () => {
  const item = line(null);
  const worker = implementor(item, worktree("small-clean", 10), "unknown-node");
  const texts = runWorker(item, worker, 0);
  assert.equal(texts.filter((t) => t.startsWith("CHANGESET")).length, 0, "no size wake");
  const report = texts.find((t) => t.startsWith("WORKER REPORT"));
  assert.ok(report, "the planner gets the full implementor report");
  assert.equal(worker.changeset.oversized, false);
});

test("a legacy completion with untracked work is blocked and sends no report", () => {
  const item = line(null);
  const wt = worktree("untracked", 10);
  fs.writeFileSync(path.join(wt.wt, "notes.txt"), "work in progress\n");
  const worker = implementor(item, wt, "unknown-node");
  const texts = runWorker(item, worker, 0);
  const blocked = texts.find((t) => t.startsWith("CHANGESET BLOCKED"));
  assert.ok(blocked, "the planner gets the safety wake");
  assert.match(blocked, /reason: untracked/);
  assert.match(blocked, /interactions\/feedback/);
  assert.ok(!texts.some((t) => t.startsWith("WORKER REPORT")), "no report reaches the planner");
  assert.equal(worker.status, "completed");
});

test("a graph completion with an oversized change set delivers the warning and the report interaction", () => {
  const graph = loadBuiltinPipeline("default", fs, path.join(__dirname, ".."));
  const item = line(graph);
  const worker = implementor(item, worktree("graph-big", 501), "backend-impl");
  const texts = runWorker(item, worker, 0);
  const warning = texts.find((t) => t.startsWith("CHANGESET OVERSIZE WARNING"));
  const report = texts.find((t) => t.startsWith("IMPLEMENTOR REPORT"));
  assert.ok(warning, "the planner gets the oversize warning");
  assert.ok(report, "the report interaction still renders");
  assert.match(report, /Did the work\./);
});

test("the timeout wake names the feedback interaction with the instructions field", () => {
  const item = line(null);
  const worker = implementor(item, worktree("timeout", 10), "unknown-node");
  const texts = runWorker(item, worker, 3);
  const timeout = texts.find((t) => t.startsWith("WORKER TIMEOUT"));
  assert.ok(timeout, "the planner gets the timeout wake");
  assert.match(timeout, /"instructions":"Finish the work from where the run was interrupted/);
  assert.ok(!timeout.includes('"prompt"'), "the example uses instructions, not prompt");
  assert.match(timeout, /interactions\/feedback/);
});
