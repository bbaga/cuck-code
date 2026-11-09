"use strict";

// Router side of one harness run. It builds the sink the plugin writes to,
// starts or resumes the plugin session, enforces the time limit and turns
// every outcome (including a rejected `done`) into one result object.

const { ON_SETTLE } = require("./harness-sdk");

const MAX_ERRORS = 5;

function createRunState(hooks) {
  const state = { sessionId: null, contextTokens: null, errors: [] };

  const sink = {
    session(id) {
      if (state.sessionId || typeof id !== "string" || !id) return;
      state.sessionId = id;
      if (hooks.onSession) hooks.onSession(id);
    },
    entry({ role, text } = {}) {
      if (typeof text !== "string" || !text) return;
      const entry = {
        type: "message",
        role: role ?? null,
        text,
        sessionId: state.sessionId,
        at: Date.now(),
      };
      if (hooks.onEntry) hooks.onEntry(entry);
    },
    contextTokens(n) {
      if (typeof n === "number" && Number.isFinite(n) && n > 0) state.contextTokens = n;
    },
    // Same rule as BaseHarness.recordError: trimmed, unique, at most 5.
    error(text) {
      if (typeof text !== "string" || !text.trim()) return;
      const trimmed = text.trim();
      if (state.errors.includes(trimmed) || state.errors.length >= MAX_ERRORS) return;
      state.errors.push(trimmed);
      if (hooks.onError) hooks.onError(trimmed);
    },
  };
  return { state, sink };
}

function startRun({ entry, ctx, request, hooks = {}, timers = {} }) {
  const plugin = entry.plugin;
  const setTimer = timers.setTimeout || setTimeout;
  const clearTimer = timers.clearTimeout || clearTimeout;
  const { state, sink } = createRunState(hooks);

  // A synchronous throw propagates: the caller reports "could not start".
  const run = request.sessionId
    ? plugin.resumeSession(ctx, request, sink)
    : plugin.startSession(ctx, request, sink);

  let timer = null;
  const native = Boolean(plugin.capabilities && plugin.capabilities.nativeTimeLimit);
  if (!native) {
    timer = setTimer(() => run.stop("SIGTERM"), request.timeLimitSec * 1000);
  }

  // The final result is built once; both settle paths share it, and
  // hooks.onDone runs one time.
  let final = null;
  let doneCalled = false;
  const finish = (result) => {
    if (!final) {
      if (timer !== null) clearTimer(timer);
      final = {
        ...result,
        sessionId: state.sessionId,
        contextTokens: state.contextTokens,
        errorText: state.errors.length ? state.errors.join("\n") : null,
      };
    }
    return final;
  };
  const notify = (result) => {
    const finished = finish(result);
    if (!doneCalled) {
      doneCalled = true;
      if (hooks.onDone) hooks.onDone(finished);
    }
    return finished;
  };

  // A run with the SDK settle hook calls onDone inside the process close
  // event. Other runs call it after done resolves.
  if (typeof run[ON_SETTLE] === "function") run[ON_SETTLE](notify);

  const done = Promise.resolve(run.done)
    .catch((err) => ({
      outcome: "fail",
      exitCode: null,
      signal: null,
      command: plugin.id,
      spawnError: err,
      stderr: null,
    }))
    .then((result) => {
      try {
        return notify(result);
      } catch (err) {
        // done never rejects: a hook error surfaces as an uncaught error.
        process.nextTick(() => { throw err; });
        return finish(result);
      }
    });

  return { kill: (signal) => run.stop(signal), done, child: run.child || null };
}

function buildCtx({ entry, env, log, sdk }) {
  const pluginId = entry.plugin.id;
  return {
    sdk,
    env: { ...env },
    pluginDir: entry.folder,
    log: (level, event, data) => log(level, event, { ...data, plugin: pluginId }),
  };
}

module.exports = { startRun, buildCtx };
