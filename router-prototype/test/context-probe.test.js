"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { sessionContextTokens, contextTokensForRun } = require("../context-probe");
const { createHarness } = require("../harness");
const { newContextStats, recordTurn, contextView, shouldAutoCompact } = require("../compaction");

function fixture(t, workdirName = "work_tree.v1") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workdir = path.join(root, workdirName);
  const env = { CLAUDE_CONFIG_DIR: path.join(root, "config") };
  const sessionId = "session-test";
  const file = path.join(env.CLAUDE_CONFIG_DIR, "projects",
    workdir.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
  return { root, workdir, env, sessionId, file };
}

function assistant(sessionId, usage, extra = {}) {
  return { type: "assistant", sessionId, message: { role: "assistant", usage }, ...extra };
}

function write(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(r => typeof r === "string" ? r : JSON.stringify(r)).join("\n") + "\n");
}

const usage = { input_tokens: 229407, cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0, output_tokens: 1421 };

test("Claude late usage comes from the completed session, not the zero-usage stream or cumulative result", t => {
  const f = fixture(t);
  const adapter = createHarness("claude");
  adapter.normalize(assistant(f.sessionId, { input_tokens: 0, output_tokens: 0 }));
  adapter.normalize({ type: "result", usage: { input_tokens: 900000, output_tokens: 9000 } });
  assert.equal(adapter.contextTokens, null);
  write(f.file, [assistant(f.sessionId, usage)]);
  const tokens = sessionContextTokens("claude", f.sessionId, f.env, f.workdir);
  const stats = newContextStats();
  recordTurn(stats, { promptChars: 260792, tokens });
  assert.deepEqual(contextView(stats, 250000), {
    tokens: 230828, estimated: false, turns: 1, compactions: 0, threshold: 250000,
  });
  assert.equal(shouldAutoCompact(stats, 250000), false);
  assert.equal(shouldAutoCompact(stats, 200000), true);
});

test("Claude uses the latest main-session call, including cached input, even after context shrinks", t => {
  const f = fixture(t);
  const latest = { input_tokens: 100, cache_creation_input_tokens: 200,
    cache_read_input_tokens: 3000, output_tokens: 40,
    cache_creation: { ephemeral_5m_input_tokens: 200 } };
  write(f.file, [
    assistant(f.sessionId, usage),
    assistant(f.sessionId, latest),
    assistant(f.sessionId, usage, { isSidechain: true }),
    assistant("other-session", usage),
    assistant(f.sessionId, usage, { is_api_error_message: true }),
    { type: "user", sessionId: f.sessionId, message: { role: "user", usage } },
    assistant(f.sessionId, { input_tokens: 0, output_tokens: 0 }),
    '{"partial":',
  ]);
  assert.equal(sessionContextTokens("claude", f.sessionId, f.env, f.workdir), 3340);
  write(f.file, [assistant(f.sessionId, { input_tokens: 50, output_tokens: 10 })]);
  assert.equal(sessionContextTokens("claude", f.sessionId, f.env, f.workdir), 60);
  fs.appendFileSync(f.file, JSON.stringify(assistant(f.sessionId, { input_tokens: 100, output_tokens: 20 })) + "\n");
  assert.equal(sessionContextTokens("claude", f.sessionId, f.env, f.workdir), 120);
});

test("Claude distinguishes planner and worker work directories under CLAUDE_CONFIG_DIR", t => {
  const f = fixture(t, "planner");
  const workerDir = path.join(f.root, "worktrees", "worker");
  const workerFile = path.join(f.env.CLAUDE_CONFIG_DIR, "projects",
    workerDir.replace(/[^a-zA-Z0-9]/g, "-"), `${f.sessionId}.jsonl`);
  write(f.file, [assistant(f.sessionId, usage)]);
  write(workerFile, [assistant(f.sessionId, { input_tokens: 100, output_tokens: 10 })]);
  assert.equal(sessionContextTokens("claude", f.sessionId, f.env, f.workdir), 230828);
  assert.equal(sessionContextTokens("claude", f.sessionId, f.env, workerDir), 110);
});

test("Claude tolerates absent, malformed, and unusable usage without reading unrelated sessions", t => {
  const f = fixture(t);
  assert.equal(sessionContextTokens("claude", f.sessionId, f.env, f.workdir), null);
  write(f.file, ["not json", assistant(f.sessionId, { input_tokens: 0 }),
    assistant(f.sessionId, { input_tokens: "9000", output_tokens: -1 })]);
  assert.equal(sessionContextTokens("claude", f.sessionId, f.env, f.workdir), null);
  for (const sessionId of ["../secret", "a/b", "a\\b", "", null]) {
    assert.equal(sessionContextTokens("claude", sessionId, f.env, f.workdir), null);
  }
  assert.equal(sessionContextTokens("claude", f.sessionId, f.env), null);
  assert.equal(sessionContextTokens("unknown", f.sessionId, f.env, f.workdir), null);
});

test("Claude finds completed usage behind large tool output and ignores a partial tail record", t => {
  const f = fixture(t);
  write(f.file, [
    { type: "user", message: { content: "x".repeat(5 * 1024 * 1024) } },
    assistant(f.sessionId, usage),
    { type: "user", sessionId: f.sessionId, message: { content: "x".repeat(1024 * 1024) } },
    '{"type":"assistant","message":',
  ]);
  assert.equal(sessionContextTokens("claude", f.sessionId, f.env, f.workdir), 230828);
});

test("Claude returns no measurement when tool output exceeds the bounded tail", t => {
  const f = fixture(t);
  write(f.file, [assistant(f.sessionId, usage),
    { type: "user", message: { content: "x".repeat(5 * 1024 * 1024) } }]);
  assert.equal(sessionContextTokens("claude", f.sessionId, f.env, f.workdir), null);
});

test("completed Claude usage wins over stale stream usage; other harnesses keep stream precedence", t => {
  const f = fixture(t);
  write(f.file, [assistant(f.sessionId, { input_tokens: 50, output_tokens: 10 })]);
  const adapter = createHarness("claude");
  adapter.contextTokens = 10000;
  assert.equal(contextTokensForRun(adapter, f.sessionId, f.env, f.workdir), 60);
  assert.equal(contextTokensForRun(adapter, "missing", f.env, f.workdir), 10000);
  const vibeDir = path.join(f.root, "vibe", "logs", "session", "session_time_abcdefgh");
  fs.mkdirSync(vibeDir, { recursive: true });
  fs.writeFileSync(path.join(vibeDir, "meta.json"), JSON.stringify({
    session_id: "abcdefgh-test", stats: { context_tokens: 20000 },
  }));
  const vibe = createHarness("vibe");
  vibe.contextTokens = 100;
  assert.equal(contextTokensForRun(vibe, "abcdefgh-test", { VIBE_HOME: path.join(f.root, "vibe") }), 100);
});
