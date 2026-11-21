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
