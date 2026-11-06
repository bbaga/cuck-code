"use strict";

// Shared run and probe code of the CLI-backed built-in plugins. It wraps the
// adapter classes of harness.js (argv, stream parsing, outcomes) in the
// plugin interface, so the built-ins behave exactly as before.

const path = require("node:path");
const { contextTokensForRun } = require("../../context-probe");

// Starts one CLI session. The request fields equal the old ctx fields, so
// adapter.buildRun(request) gives the same plan as before. A buildRun throw
// (for example a refused system prompt) propagates: "could not start".
function cliSessionRun(sdk, ctx, AdapterClass, id, request, sink) {
  const adapter = new AdapterClass(id);
  const plan = adapter.buildRun(request);

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
      // Same env and cwd as the server used for the context probe.
      const env = { ...process.env, ...plan.env };
      const cwd = plan.cwd === undefined ? process.cwd() : path.resolve(plan.cwd);
      runSink.contextTokens(contextTokensForRun(adapter, adapter.sessionId, env, cwd));
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
