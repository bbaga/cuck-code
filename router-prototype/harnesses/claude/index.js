"use strict";

// Built-in claude harness (Claude Code CLI).

const { ClaudeHarness } = require("../../harness");
const claudeConfig = require("../../claude-config");
const { claudeModelChoices } = require("../../pipeline-config");
const { findSession, readSession } = require("../../transcript-history");
const { cliSessionRun, probeCli } = require("../shared/cli-plugin");

module.exports = function createHarnessPlugin(sdk) {
  const start = (ctx, request, sink) => cliSessionRun(sdk, ctx, ClaudeHarness, "claude", request, sink);
  return {
    apiVersion: 1,
    id: "claude",
    displayName: "Claude",
    capabilities: { resume: true, systemPrompt: "file", nativeTimeLimit: false, providers: false },
    probe: () => probeCli(sdk, {
      versionCmd: ["claude", "--version"],
      authCmd: ["claude", "auth", "status"],
      loginHint: "claude login",
    }),
    async listModels() {
      // Looked up on the module at call time so tests can replace the reader.
      let config;
      try { config = await claudeConfig.readClaudeConfig(); }
      catch { config = null; }
      return claudeModelChoices(config);
    },
    startSession: start,
    resumeSession: start,
    async readTranscript(ctx, { sessionId, workdir }) {
      const file = await findSession({ harness: "claude", sessionId, workdir }, ctx.env);
      return file ? readSession(file, "claude", sessionId) : null;
    },
  };
};
