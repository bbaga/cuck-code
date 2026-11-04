"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// LINES_DIR is read when the server module loads. Set it first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-transcript-"));
process.env.LINES_DIR = path.join(root, "lines");
const server = require("../server");

function makeLine(transcript) {
  const workdir = path.join(process.env.LINES_DIR, "line-t");
  fs.mkdirSync(workdir, { recursive: true });
  const worker = { id: "w1", name: "impl", role: "implementor", status: "done",
    branch: "b", worktreePath: path.join(workdir, "wt"), transcript };
  return { id: "line-t", name: "t", workdir, workers: new Map([["w1", worker]]),
    transcript: [], queue: [], status: "idle", started: true, repos: new Map(), inventory: new Map(),
    evidence: new Map() };
}

test("restore keeps the last 500 entries and drops invalid ones", () => {
  const input = [null, "x", 5, {}];
  for (let i = 0; i < 600; i++) input.push({ type: "message", role: "assistant", text: `m${i}`, at: i });
  const out = server.restoreWorkerTranscript(input);
  assert.equal(out.length, 500);
  assert.equal(out[0].text, "m100");
  assert.equal(out[499].text, "m599");
  assert.deepEqual(server.restoreWorkerTranscript("nope"), []);
});

test("normalize keeps only known fields", () => {
  const e = server.normalizeWorkerTranscriptEntry({ type: "message", text: "a", at: 1, secret: "s" });
  assert.deepEqual(e, { type: "message", text: "a", at: 1 });
  assert.equal(server.normalizeWorkerTranscriptEntry(null), null);
});

test("dashboard state carries only the last 50 entries", () => {
  const t = Array.from({ length: 80 }, (_, i) => ({ type: "message", text: `m${i}` }));
  const state = server.dashboardStateForLine(makeLine(t));
  const got = state.workers[0].transcript;
  assert.equal(got.length, 50);
  assert.equal(got[0].text, "m30");
});

test("saveLine and loadLines round trip a worker transcript", () => {
  const t = Array.from({ length: 520 }, (_, i) => ({ type: "message", role: "assistant", text: `m${i}`, at: i }));
  const line = makeLine(t);
  assert.notEqual(server.saveLine(line), false);
  const saved = JSON.parse(fs.readFileSync(path.join(line.workdir, "line.json"), "utf8"));
  assert.equal(saved.workers[0].transcript.length, 500);
  server.lines.clear();
  server.loadLines();
  const loaded = server.lines.get("line-t");
  assert.ok(loaded, "line restored");
  const tr = loaded.workers.get("w1").transcript;
  assert.equal(tr.length, 500);
  assert.equal(tr[0].text, "m20");
  assert.equal(tr[499].text, "m519");
});
