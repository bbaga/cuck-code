"use strict";

// loadTranscript reads saved entries through a plugin's readTranscript when
// the registry entry is given. Fake in-memory plugins stand in for harnesses.

const { test, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { registerHarness, unregisterPluginHarnesses, getHarness } = require("../harness-registry");
const { loadTranscript } = require("../transcript-history");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-plugin-"));
process.env.LINES_DIR = root;
const server = require("../server");
after(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => unregisterPluginHarnesses());

const msg = (role, text, at, extra = {}) =>
  ({ type: "message", role, text, sessionId: "s1", at, ...extra });

function fakePlugin(id, readTranscript) {
  return { apiVersion: 1, id,
    capabilities: { resume: true, systemPrompt: "none", nativeTimeLimit: true, providers: false },
    async probe() { return { installed: true, version: null, auth: "ok", loginHint: "" }; },
    async listModels() { return []; },
    startSession() { throw new Error("unused"); },
    resumeSession() { throw new Error("unused"); },
    readTranscript };
}

function register(id, readTranscript) {
  registerHarness(fakePlugin(id, readTranscript), { layer: "user", folder: `/tmp/${id}` });
  return getHarness(id);
}

const target = (transcript = []) => ({ harness: "fake", sessionId: "s1", workdir: "/w", transcript });

test("plugin entries merge with live entries without duplicates, sorted by time", async () => {
  const calls = [];
  const entry = register("fake", async (ctx, q) => {
    calls.push({ ctx, q });
    return [msg("user", "first", 1000), msg("assistant", "answer", 2000)];
  });
  const live = [msg("assistant", "answer", 2100), msg("user", "later", 3000)];
  const ctx = { marker: true };
  const result = await loadTranscript(target(live), { entry, ctx });
  assert.deepEqual(result.entries.map(e => e.text), ["first", "answer", "later"]);
  assert.equal(result.entries[1].at, 2100);
  assert.equal(result.available, true);
  assert.deepEqual(calls, [{ ctx, q: { sessionId: "s1", workdir: "/w" } }]);
});

test("a null plugin result gives live entries only", async () => {
  const entry = register("fake", async () => null);
  const empty = await loadTranscript(target(), { entry, ctx: {} });
  assert.deepEqual(empty, { entries: [], truncated: false, available: false });
  const live = [msg("user", "hi", 1)];
  const withLive = await loadTranscript(target(live), { entry, ctx: {} });
  assert.deepEqual(withLive.entries, live);
  assert.equal(withLive.available, true);
});

test("a result that is not an array counts as null", async () => {
  const entry = register("fake", async () => ({ not: "an array" }));
  const result = await loadTranscript(target(), { entry, ctx: {} });
  assert.deepEqual(result, { entries: [], truncated: false, available: false });
});

test("a throwing plugin is logged and gives live entries only", async () => {
  const entry = register("fake", async () => { throw new Error("boom"); });
  const logs = [];
  const live = [msg("user", "hi", 1)];
  const result = await loadTranscript(target(live),
    { entry, ctx: {}, log: (...args) => logs.push(args) });
  assert.deepEqual(result.entries, live);
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0].slice(0, 2), ["warn", "transcript.plugin-failed"]);
  assert.equal(logs[0][2].harness, "fake");
  assert.match(logs[0][2].error, /boom/);
});

test("a throwing plugin does not need a log function", async () => {
  const entry = register("fake", () => { throw new Error("sync boom"); });
  const result = await loadTranscript(target(), { entry, ctx: {} });
  assert.equal(result.available, false);
});

function write(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join("\n") + "\n");
}

// The built-in plugin path must equal the old findSession/readSession path.
const builtinCases = (dir, workdir) => ({
  claude: { env: { CLAUDE_CONFIG_DIR: path.join(dir, "claude") },
    file: path.join(dir, "claude", "projects", workdir.replace(/[^a-zA-Z0-9]/g, "-"), "sess.jsonl"),
    records: [
      { type: "user", uuid: "u", sessionId: "sess", timestamp: new Date(1000).toISOString(), message: { role: "user", content: "Fix it" } },
      { type: "assistant", uuid: "a", sessionId: "sess", timestamp: new Date(2000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    ] },
  codex: { env: { CODEX_HOME: path.join(dir, "codex") },
    file: path.join(dir, "codex", "sessions", "2026", "01", "01", "rollout-sess.jsonl"),
    records: [
      { type: "response_item", timestamp: new Date(1000).toISOString(), payload: { role: "user", content: [{ type: "input_text", text: "Fix it" }] } },
      { type: "response_item", timestamp: new Date(2000).toISOString(), payload: { role: "assistant", content: [{ type: "output_text", text: "Done" }] } },
    ] },
  pi: { env: { PI_CODING_AGENT_DIR: path.join(dir, "pi") },
    file: path.join(workdir, "sessions", "time_sess.jsonl"),
    records: [
      { type: "session", id: "sess" },
      { type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text: "Fix it" }], timestamp: 1000 } },
      { type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 2000 } },
    ] },
});

for (const id of ["claude", "codex", "pi"]) {
  test(`the built-in ${id} plugin path equals the old file path`, async (t) => {
    const dir = fs.mkdtempSync(path.join(root, "builtin-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const workdir = path.join(dir, "worktree");
    fs.mkdirSync(workdir);
    const c = builtinCases(dir, workdir)[id];
    write(c.file, c.records);
    const t1 = { harness: id, sessionId: "sess", workdir, transcript: [] };
    const old = await loadTranscript(t1, { env: c.env });
    const viaPlugin = await loadTranscript(t1, { entry: getHarness(id), ctx: { env: c.env } });
    assert.equal(old.available, true);
    assert.deepEqual(old.entries.map(e => e.text), ["Fix it", "Done"]);
    assert.deepEqual(viaPlugin, old);
    const missing = { ...t1, sessionId: "none" };
    assert.deepEqual(await loadTranscript(missing, { entry: getHarness(id), ctx: { env: c.env } }),
      await loadTranscript(missing, { env: c.env }));
  });
}

test("the transcript route reads saved entries from a plugin harness", async () => {
  register("fake-route", async (ctx, q) => [msg("assistant", `saved ${q.sessionId}`, 1000)]);
  const item = { id: "tr-line", name: "tr", status: "idle", deleted: false, started: true,
    planApproved: true, queue: [], transcript: [msg("user", "live", 2000)], workers: new Map(),
    clients: new Set(), inventory: new Map(), repos: new Map(), pendingValidations: [],
    sessionId: "s9", sessionCfg: { harness: "fake-route" }, workdir: root };
  server.lines.set(item.id, item);
  const srv = http.createServer(server.requestHandler);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/lines/tr-line/transcript`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.entries.map(e => e.text), ["saved s9", "live"]);
    assert.equal(body.available, true);
  } finally {
    srv.close();
    server.lines.delete(item.id);
  }
});
