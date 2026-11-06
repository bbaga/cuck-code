"use strict";

// Router side of one harness run. It builds the sink the plugin writes to,
// starts or resumes the plugin session, enforces the time limit and turns
// every outcome (including a rejected `done`) into one result object.

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
      if (timer !== null) clearTimer(timer);
      return {
        ...result,
        sessionId: state.sessionId,
        contextTokens: state.contextTokens,
        errorText: state.errors.length ? state.errors.join("\n") : null,
      };
    });

  return { kill: (signal) => run.stop(signal), done };
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
