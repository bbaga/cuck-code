"use strict";

// Shared run and probe code of the CLI-backed built-in plugins. It wraps the
// adapter classes of harness.js (argv, stream parsing, outcomes) in the
// plugin interface, so the built-ins behave exactly as before.

const path = require("node:path");
// Kept as a module object so a test can observe the call.
const contextProbe = require("../../context-probe");

// Starts one CLI session. The request fields equal the old ctx fields, so
// adapter.buildRun(request) gives the same plan as before. A buildRun throw
// (for example a refused system prompt) propagates: "could not start".
// overrides = { command, args, env } lets a derived plugin run another
// command in front of the base argv. Without it the plan does not change.
function cliSessionRun(sdk, ctx, AdapterClass, id, request, sink, overrides = null) {
  const adapter = new AdapterClass(id);
  const plan = adapter.buildRun(request);
  if (overrides) {
    plan.cmd = overrides.command;
    plan.args = [...(overrides.args || []), ...plan.args];
    plan.env = { ...plan.env, ...overrides.env };
  }

  // Same env and cwd as the server used for the context probe. They are fixed
  // at start: the process env can change before the stream ends.
  const env = { ...process.env, ...plan.env };
  const cwd = plan.cwd === undefined ? process.cwd() : path.resolve(plan.cwd);

  const parser = {
    record(obj, runSink) {
      const entry = adapter.normalize(obj);
      if (!entry) return;
      runSink.session(entry.sessionId);
      runSink.entry(entry);
    },
    end(runSink) {
      const last = adapter.finalize();
      if (last) {
        runSink.session(last.sessionId);
        runSink.entry(last);
      }
      for (const text of adapter.streamErrors || []) runSink.error(text);
      // A resumed stream can omit the session id: fall back to the requested one.
      const sessionId = adapter.sessionId || request.sessionId;
      runSink.contextTokens(contextProbe.contextTokensForRun(adapter, sessionId, env, cwd));
    },
    outcome(code, signal) {
      return adapter.outcome(code, signal);
    },
  };
  return sdk.spawnJsonl(plan, parser, sink);
}

// Probe with the rules of probeHarnesses: installed = version command ran,
// version = first stdout line, auth from the optional auth command.
async function probeCli(sdk, { versionCmd, authCmd = null, loginHint }) {
  const versionRes = await sdk.runCommand(versionCmd);
  let auth = "unknown";
  if (authCmd) {
    const authRes = await sdk.runCommand(authCmd);
    if (authRes) auth = authRes.code === 0 ? "ok" : "missing";
  }
  return {
    installed: versionRes != null,
    version: versionRes && versionRes.stdout != null
      ? String(versionRes.stdout).split("\n")[0].trim() || null
      : null,
    auth,
    loginHint,
  };
}

module.exports = { cliSessionRun, probeCli };
