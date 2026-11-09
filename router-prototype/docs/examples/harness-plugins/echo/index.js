"use strict";

// A pure JavaScript harness plugin. It starts no child process: the report
// is the first 200 characters of the prompt.

const crypto = require("node:crypto");

module.exports = function createHarnessPlugin() {
  // The run settles on the next tick, so the router sees a started run first.
  function run(sessionId, request, sink) {
    sink.session(sessionId);
    sink.entry({ role: "assistant", text: String(request.prompt).slice(0, 200) });
    const result = { outcome: "ok", exitCode: 0, signal: null, command: "echo", spawnError: null, stderr: null };
    return { stop: () => false, done: new Promise((resolve) => setImmediate(() => resolve(result))) };
  }

  return {
    apiVersion: 1,
    id: "echo",
    displayName: "Echo",
    capabilities: { resume: true, systemPrompt: "none", nativeTimeLimit: true, providers: false },
    async probe() { return { installed: true, version: "echo 1", auth: "ok", loginHint: "" }; },
    async listModels() { return [{ value: "echo", label: "Echo" }]; },
    startSession: (ctx, request, sink) => run(`echo-${crypto.randomBytes(4).toString("hex")}`, request, sink),
    resumeSession: (ctx, request, sink) => run(request.sessionId, request, sink),
  };
};
