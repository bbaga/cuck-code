"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startRun, buildCtx } = require("../harness-runner");
const { ON_SETTLE } = require("../harness-sdk");
const { createFakeClock } = require("./fixtures/fake-clock");

function fakePlugin({ native = false, rejectDone = false, onStart } = {}) {
  const calls = { start: 0, resume: 0, stops: [] };
  let resolveDone;
  const make = (kind) => (ctx, request, sink) => {
    calls[kind] += 1;
    if (onStart) onStart(sink);
    const done = rejectDone
      ? Promise.reject(new Error("boom"))
      : new Promise((resolve) => { resolveDone = resolve; });
    return { stop(signal) { calls.stops.push(signal); return true; }, done };
  };
  return {
    calls,
    finish: (r) => resolveDone({ outcome: "ok", exitCode: 0, signal: null, command: "x", spawnError: null, stderr: null, ...r }),
    entry: {
      plugin: {
        id: "fake",
        capabilities: { nativeTimeLimit: native },
        startSession: make("start"),
        resumeSession: make("resume"),
      },
    },
  };
}

const req = (extra) => ({ timeLimitSec: 10, sessionId: null, ...extra });

test("startSession vs resumeSession", () => {
  const a = fakePlugin();
  startRun({ entry: a.entry, ctx: {}, request: req(), timers: createFakeClock() });
  assert.deepEqual([a.calls.start, a.calls.resume], [1, 0]);
  const b = fakePlugin();
  startRun({ entry: b.entry, ctx: {}, request: req({ sessionId: "s" }), timers: createFakeClock() });
  assert.deepEqual([b.calls.start, b.calls.resume], [0, 1]);
});

test("synchronous start throw propagates", () => {
  const p = fakePlugin();
  p.entry.plugin.startSession = () => { throw new Error("nope"); };
  assert.throws(() => startRun({ entry: p.entry, ctx: {}, request: req(), timers: createFakeClock() }), /nope/);
});

test("sink rules", async () => {
  const entries = [];
  const sessions = [];
  const errors = [];
  const p = fakePlugin({
    onStart(sink) {
      sink.entry({ role: "assistant", text: "before" });
      sink.session("");
      sink.session("s1");
      sink.session("s2");
      sink.entry({ text: "after" });
      sink.entry({ role: "assistant", text: "" });
      sink.contextTokens(100);
      sink.contextTokens(-5);
      sink.contextTokens(NaN);
      sink.contextTokens(200);
      for (const t of [" a ", "a", "", "b", "c", "d", "e", "f"]) sink.error(t);
    },
  });
  const handle = startRun({
    entry: p.entry, ctx: {}, request: req(), timers: createFakeClock(),
    hooks: { onEntry: (e) => entries.push(e), onSession: (id) => sessions.push(id), onError: (t) => errors.push(t) },
  });
  p.finish();
  const result = await handle.done;
  assert.deepEqual(sessions, ["s1"]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].sessionId, null);
  assert.equal(entries[1].sessionId, "s1");
  assert.equal(entries[1].role, null);
  assert.equal(entries[1].type, "message");
  assert.equal(typeof entries[1].at, "number");
  assert.equal(result.sessionId, "s1");
  assert.equal(result.contextTokens, 200);
  assert.equal(result.errorText, "a\nb\nc\nd\ne");
  assert.deepEqual(errors, ["a", "b", "c", "d", "e"]);
  assert.equal(result.outcome, "ok");
});

test("time limit calls stop(SIGTERM) and done clears the timer", async () => {
  const clock = createFakeClock();
  const p = fakePlugin();
  const handle = startRun({ entry: p.entry, ctx: {}, request: req(), timers: clock });
  clock.advance(9999);
  assert.deepEqual(p.calls.stops, []);
  clock.advance(1);
  assert.deepEqual(p.calls.stops, ["SIGTERM"]);

  const q = fakePlugin();
  const h2 = startRun({ entry: q.entry, ctx: {}, request: req(), timers: clock });
  q.finish();
  await h2.done;
  clock.advance(20000);
  assert.deepEqual(q.calls.stops, []);
  p.finish();
  await handle.done;
});

test("nativeTimeLimit skips the timer", () => {
  const clock = createFakeClock();
  const p = fakePlugin({ native: true });
  startRun({ entry: p.entry, ctx: {}, request: req(), timers: clock });
  clock.advance(1e6);
  assert.deepEqual(p.calls.stops, []);
});

test("rejected done resolves to fail", async () => {
  const p = fakePlugin({ rejectDone: true });
  const result = await startRun({ entry: p.entry, ctx: {}, request: req(), timers: createFakeClock() }).done;
  assert.equal(result.outcome, "fail");
  assert.equal(result.command, "fake");
  assert.equal(result.spawnError.message, "boom");
  assert.equal(result.exitCode, null);
  assert.equal(result.errorText, null);
});

test("kill delegates to stop", () => {
  const p = fakePlugin();
  const handle = startRun({ entry: p.entry, ctx: {}, request: req(), timers: createFakeClock() });
  assert.equal(handle.kill("SIGKILL"), true);
  assert.deepEqual(p.calls.stops, ["SIGKILL"]);
});

test("buildCtx", () => {
  const logs = [];
  const env = { A: "1" };
  const ctx = buildCtx({
    entry: { plugin: { id: "fake" }, folder: "/dir" }, env, sdk: { s: 1 },
    log: (...a) => logs.push(a),
  });
  assert.equal(ctx.pluginDir, "/dir");
  assert.deepEqual(ctx.sdk, { s: 1 });
  assert.deepEqual(ctx.env, env);
  assert.notEqual(ctx.env, env);
  ctx.log("info", "ev", { k: 1 });
  assert.deepEqual(logs, [["info", "ev", { k: 1, plugin: "fake" }]]);
});

// A plugin run like the SDK one: it settles synchronously through ON_SETTLE.
function settlingPlugin() {
  const callbacks = [];
  let resolveDone;
  const result = { outcome: "ok", exitCode: 0, signal: null, command: "x", spawnError: null, stderr: null };
  const child = { pid: 1 };
  return {
    settle: () => { resolveDone(result); for (const cb of callbacks) cb(result); },
    entry: { plugin: { id: "settling", capabilities: { nativeTimeLimit: true },
      startSession: () => {
        const run = { stop: () => true, child,
          done: new Promise((resolve) => { resolveDone = resolve; }) };
        Object.defineProperty(run, ON_SETTLE, { value: (cb) => { callbacks.push(cb); } });
        return run;
      } } },
    child,
  };
}

test("onDone runs synchronously for a run with ON_SETTLE", async () => {
  const fake = settlingPlugin();
  const seen = [];
  const handle = startRun({ entry: fake.entry, ctx: {}, request: req(),
    hooks: { onDone: (r) => seen.push(r) } });
  fake.settle();
  assert.equal(seen.length, 1);
  assert.equal(await handle.done, seen[0]);
  assert.equal(seen.length, 1);
});

test("onDone runs after done for a run without ON_SETTLE, one time", async () => {
  const fake = fakePlugin({ native: true });
  const seen = [];
  const handle = startRun({ entry: fake.entry, ctx: {}, request: req(),
    hooks: { onDone: (r) => seen.push(r) } });
  fake.finish({});
  assert.equal(seen.length, 0);
  const result = await handle.done;
  assert.deepEqual(seen, [result]);
  await handle.done;
  assert.equal(seen.length, 1);
});

test("handle.child is the run child or null", () => {
  const fake = settlingPlugin();
  const withChild = startRun({ entry: fake.entry, ctx: {}, request: req() });
  assert.equal(withChild.child, fake.child);
  const plain = startRun({ entry: fakePlugin({ native: true }).entry, ctx: {}, request: req() });
  assert.equal(plain.child, null);
});
