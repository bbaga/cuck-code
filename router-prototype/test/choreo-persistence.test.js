"use strict";

// The chain state of a head and the pending handoffs survive a save and a load.
// A line saved before the choreographed pipelines loads with default values.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "choreo-persistence-"));
process.env.LINES_DIR = root;
const server = require("../server");
const { loadBuiltinPipeline } = require("../line-graph");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const graph = loadBuiltinPipeline("choreographed", fs, path.join(__dirname, ".."));
const { restorePendingHandoffs } = require("../chain-runtime");
const stage = { sender: "impl", headRun: 2,
  members: { val: { status: "done", checkerId: "c1", outcome: "pass" } } };
// Entries of an older head run: loadLines drops them after it restores them.
const pendingHandoffs = [{ to: "val", headId: "h1", headRun: 1 }];

function seed(id, { saved }) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const worker = { id: "h1", name: "impl", node: "impl", role: "implementor", persona: "backend",
    status: "completed", repo: "api", branch: "b/impl", runGeneration: 2, worktreePath: dir,
    ...(saved ? { chainFields: { criteria: "Be right." }, reworkRounds: { impl: 2 }, stage } : {}) };
  fs.writeFileSync(path.join(dir, "line.json"), JSON.stringify({ id, name: id, layout: 2, started: true,
    planApproved: true, graph, workers: [worker], ...(saved ? { pendingHandoffs } : {}) }));
}

test("a line saved with chain state loads again with the same values", () => {
  seed("with-chain", { saved: true });
  server.loadLines();
  const line = server.lines.get("with-chain");
  const head = line.workers.get("h1");
  assert.deepEqual(head.chainFields, { criteria: "Be right." });
  assert.deepEqual(head.reworkRounds, { impl: 2 });
  assert.deepEqual(head.stage, stage);
  assert.deepEqual(line.pendingHandoffs, [], "the entry of an older run is dropped");
  const saved = JSON.parse(fs.readFileSync(path.join(root, "with-chain", "line.json"), "utf8"));
  assert.deepEqual(saved.workers[0].stage, stage);
  assert.deepEqual(saved.workers[0].reworkRounds, { impl: 2 });
});

test("pending handoffs are saved and restored; broken entries are dropped", () => {
  savePending();
  assert.deepEqual(restorePendingHandoffs([...pendingHandoffs, { to: 1 }, null, "x"]), pendingHandoffs);
  assert.deepEqual(restorePendingHandoffs(undefined), []);
});

function savePending() {
  const line = server.lines.get("with-chain");
  line.pendingHandoffs = pendingHandoffs;
  assert.equal(server.saveLine(line), true);
  const saved = JSON.parse(fs.readFileSync(path.join(root, "with-chain", "line.json"), "utf8"));
  assert.deepEqual(saved.pendingHandoffs, pendingHandoffs);
}

test("a line saved before the chain fields loads with default values", () => {
  seed("old-line", { saved: false });
  server.loadLines();
  const line = server.lines.get("old-line");
  const head = line.workers.get("h1");
  assert.deepEqual(head.chainFields, {});
  assert.deepEqual(head.reworkRounds, {});
  assert.equal(head.stage, null);
  assert.deepEqual(line.pendingHandoffs, []);
});

// A saved line with a real git worktree for its head, so that a checker can start after the load.
const { execFileSync } = require("node:child_process");
const { createFakeChild } = require("./fixtures/planner-child");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
  { encoding: "utf8" }).trim();

function seedWithWorktree(id, { stageMember, pending = [], busy = 0 }) {
  const dir = path.join(root, id);
  const wt = path.join(root, `${id}-wt`);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(wt);
  git(wt, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(wt, "a.txt"), "base\n");
  git(wt, "add", ".");
  git(wt, "commit", "-qm", "base");
  const base = git(wt, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(wt, "work.js"), "// work\n");
  git(wt, "add", ".");
  git(wt, "commit", "-qm", "work");
  const head = { id: "h1", name: "impl", node: "impl", role: "implementor", persona: "backend", status: "completed",
    repo: "api", branch: "b/impl", runGeneration: 2, worktreePath: wt, baseCommit: base, sessionId: "s-1",
    lastCompletedInvocationId: "inv-1", lastRunText: "Did the work.", chainFields: { criteria: "Be right." },
    reworkRounds: {}, stage: { sender: "impl", headRun: 2, members: { val: stageMember } } };
  const others = Array.from({ length: busy }, (_, i) => ({ id: `busy-${i}`, name: `busy-${i}`, node: "impl",
    role: "implementor", persona: "backend", status: "running", worktreePath: wt }));
  fs.writeFileSync(path.join(dir, "line.json"), JSON.stringify({ id, name: id, layout: 2, started: true,
    planApproved: true, graph, workers: [head, ...others], pendingHandoffs: pending }));
  return dir;
}

function fakeSpawn() {
  const spawned = [];
  server.setSpawnForTest((cmd, args) => {
    spawned.push(JSON.stringify(args));
    return createFakeChild();
  });
  return spawned;
}

test("a valid pending handoff is saved, restored and started after the load frees the slots", () => {
  const entry = { to: "val", headId: "h1", headRun: 2 };
  const dir = seedWithWorktree("pending-valid", { busy: 8, pending: [entry],
    stageMember: { status: "queued", checkerId: null, outcome: null } });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "line.json"), "utf8"));
  assert.deepEqual(saved.pendingHandoffs, [entry], "the file holds the entry");
  const spawned = fakeSpawn();
  server.loadLines();
  const line = server.lines.get("pending-valid");
  // Running workers load as stopped, so the cap is free: the load starts the checker.
  assert.equal([...line.workers.values()].filter((w) => w.id.startsWith("busy-") && w.status === "stopped").length, 8);
  assert.deepEqual(line.pendingHandoffs, []);
  const head = line.workers.get("h1");
  assert.equal(head.stage.members.val.status, "running");
  const checker = line.workers.get(head.stage.members.val.checkerId);
  assert.equal(checker.validates, "h1");
  assert.match(checker.prompt, /Be right\./);
  assert.equal(spawned.length, 1);
  const again = JSON.parse(fs.readFileSync(path.join(dir, "line.json"), "utf8"));
  assert.deepEqual(again.pendingHandoffs, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a valid pending handoff stays queued while the cap is full and starts when a slot frees", () => {
  const entry = { to: "val", headId: "h1", headRun: 2 };
  const dir = seedWithWorktree("pending-full", {
    stageMember: { status: "queued", checkerId: null, outcome: null } });
  const spawned = fakeSpawn();
  server.loadLines();
  const line = server.lines.get("pending-full");
  // Fill the cap with running workers, then queue the handoff and save the line.
  for (let i = 0; i < 8; i++) {
    line.workers.set(`full-${i}`, { id: `full-${i}`, name: `full-${i}`, role: "implementor", status: "running" });
  }
  const head = line.workers.get("h1");
  line.pendingHandoffs = [entry];
  server.saveLine(line);
  server.drainPendingHandoffs(line);
  assert.deepEqual(line.pendingHandoffs, [entry]);
  assert.equal(head.stage.members.val.status, "queued");
  const file = JSON.parse(fs.readFileSync(path.join(dir, "line.json"), "utf8"));
  assert.deepEqual(file.pendingHandoffs, [entry]);
  assert.equal(file.workers.find((w) => w.id === "h1").stage.members.val.status, "queued");
  // A slot frees: the drain starts the checker and removes the entry.
  line.workers.get("full-0").status = "completed";
  const before = spawned.length;
  server.drainPendingHandoffs(line);
  assert.deepEqual(line.pendingHandoffs, []);
  assert.equal(head.stage.members.val.status, "running");
  assert.equal(spawned.length, before + 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("recoverAfterLoad ends a stage whose running checker was lost in a restart", () => {
  const dir = seedWithWorktree("recover", {
    stageMember: { status: "running", checkerId: "lost-checker", outcome: null } });
  const spawned = fakeSpawn();
  server.loadLines();
  const line = server.lines.get("recover");
  const head = line.workers.get("h1");
  assert.equal(head.stage, null);
  // The first wake starts the planner run: it is the active request. Later wakes wait in the queue.
  const wakes = [line.activePlannerRequest, ...line.queue].filter(Boolean).map((r) => r.text);
  assert.equal(wakes.length, 1);
  assert.match(wakes[0], /^HANDOFF FAILED - val could not start for 'impl': the router restarted/);
  assert.match(wakes[0], /IMPLEMENTOR REPORT/);
  assert.ok(!spawned.some((args) => args.includes("REWORK REQUEST")), "no rework is sent");
  assert.equal(head.reworkRounds.impl, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});
