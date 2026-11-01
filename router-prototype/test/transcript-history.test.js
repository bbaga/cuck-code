"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadTranscript, findSession } = require("../transcript-history");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workdir = path.join(root, "worktree");
  fs.mkdirSync(workdir);
  return { root, workdir, env: { PI_CODING_AGENT_DIR: path.join(root, "pi"), CLAUDE_CONFIG_DIR: path.join(root, "claude") } };
}
function write(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(r => typeof r === "string" ? r : JSON.stringify(r)).join("\n") + "\n");
}
function pi(id, parentId, role, text, at = 1000) {
  return { type: "message", id, parentId, message: { role, content: [{ type: "text", text }], timestamp: at } };
}

test("Pi history follows the active branch and excludes system/tool/reasoning content", async t => {
  const f = fixture(t);
  write(path.join(f.workdir, "sessions", "time_session-a.jsonl"), [
    { type: "session", id: "session-a" },
    pi("sys", null, "system", "hidden policy"),
    pi("u", "sys", "user", "Build a feature"),
    pi("abandoned", "u", "assistant", "abandoned branch"),
    pi("answer", "u", "assistant", "The current answer", 2000),
    pi("tool", "answer", "toolResult", "not chat"),
    '{"partial":',
  ]);
  const result = await loadTranscript({ harness: "pi", sessionId: "session-a", workdir: f.workdir }, { env: f.env });
  assert.equal(result.available, true);
  assert.deepEqual(result.entries.map(e => e.text), ["Build a feature", "The current answer"]);
});

test("Claude history survives restart and combines with racing live entries without duplicates", async t => {
  const f = fixture(t);
  const file = path.join(f.env.CLAUDE_CONFIG_DIR, "projects", f.workdir.replace(/[^a-zA-Z0-9]/g, "-"), "session-b.jsonl");
  write(file, [
    { type: "user", uuid: "u", sessionId: "session-b", timestamp: new Date(1000).toISOString(), message: { role: "user", content: "Please fix this" } },
    { type: "assistant", uuid: "a", sessionId: "session-b", timestamp: new Date(2000).toISOString(), message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Fixed it" }] } },
    { type: "user", uuid: "foreign", sessionId: "other-session", message: { role: "user", content: "unrelated" } },
  ]);
  const target = { harness: "claude", sessionId: "session-b", workdir: f.workdir, transcript: [
    { type: "message", entryId: "live-a", sessionId: "session-b", role: "assistant", text: "Fixed it", at: 2100 },
    { type: "message", entryId: "live-b", sessionId: "session-b", role: "user", text: "Follow up", at: 3000 },
  ] };
  const result = await loadTranscript(target, { env: f.env });
  assert.deepEqual(result.entries.map(e => e.text), ["Please fix this", "Fixed it", "Follow up"]);
  assert.equal(result.entries[1].entryId, "live-a");
  const afterRestart = await loadTranscript({ ...target, transcript: [] }, { env: f.env });
  assert.deepEqual(afterRestart.entries.map(e => e.text), ["Please fix this", "Fixed it"]);
});

test("missing sessions are explicit and session IDs cannot traverse directories", async t => {
  const f = fixture(t);
  assert.equal(await findSession({ harness: "claude", sessionId: "../secret", workdir: f.workdir }, f.env), null);
  assert.deepEqual(await loadTranscript({ harness: "pi", sessionId: "missing", workdir: f.workdir }, { env: f.env }),
    { entries: [], truncated: false, available: false });
});

test("history is bounded and preserves repeated identical messages on separate turns", async t => {
  const f = fixture(t);
  const records = [{ type: "session", id: "bounded" }];
  for (let i = 0; i < 510; i++) records.push(pi(String(i), i ? String(i - 1) : null, "user", "repeat", i * 20_000));
  write(path.join(f.workdir, "sessions", "time_bounded.jsonl"), records);
  const result = await loadTranscript({ harness: "pi", sessionId: "bounded", workdir: f.workdir }, { env: f.env });
  assert.equal(result.entries.length, 500);
  assert.equal(result.truncated, true);
  assert.equal(result.entries[0].at, 200_000);
});
