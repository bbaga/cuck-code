"use strict";

// In-memory echo harness for the loading tests. It spawns no process.

module.exports = function createHarnessPlugin() {
  const run = (ctx, request, sink) => {
    sink.session(request.sessionId || "echo-session");
    sink.entry({ role: "assistant", text: `echo: ${request.prompt}` });
    const result = { outcome: "ok", exitCode: 0, signal: null, command: "echo", spawnError: null, stderr: null };
    return { stop: () => false, done: Promise.resolve(result) };
  };
  return {
    apiVersion: 1,
    id: "good",
    displayName: "Good Echo",
    capabilities: { resume: true, systemPrompt: "none", nativeTimeLimit: false, providers: false },
    probe: async () => ({ installed: true, version: "1.0.0", auth: "ok", loginHint: "" }),
    listModels: async () => [{ value: "echo-1", label: "Echo 1" }],
    startSession: run,
    resumeSession: run,
  };
};
