"use strict";

// Built-in codex harness (OpenAI Codex CLI).

const { CodexHarness } = require("../../harness");
const { findSession, readSession } = require("../../transcript-history");
const { cliSessionRun, probeCli } = require("../shared/cli-plugin");

module.exports = function createHarnessPlugin(sdk) {
  const start = (ctx, request, sink) => cliSessionRun(sdk, ctx, CodexHarness, "codex", request, sink);
  return {
    apiVersion: 1,
    id: "codex",
    displayName: "Codex",
    capabilities: { resume: true, systemPrompt: "text", nativeTimeLimit: false, providers: false },
    probe: () => probeCli(sdk, {
      versionCmd: ["codex", "--version"],
      authCmd: ["codex", "login", "status"],
      loginHint: "codex login",
    }),
    listModels: async () => [],
    startSession: start,
    resumeSession: start,
    async readTranscript(ctx, { sessionId, workdir }) {
      const file = await findSession({ harness: "codex", sessionId, workdir }, ctx.env);
      return file ? readSession(file, "codex", sessionId) : null;
    },
  };
};
