"use strict";

// Built-in vibe harness (Mistral Vibe CLI).

const { VibeHarness } = require("../../harness");
const { vibeModelChoices } = require("../../pipeline-config");
const { cliSessionRun, probeCli } = require("../shared/cli-plugin");

const LOGIN_HINT = "vibe --setup";

module.exports = function createHarnessPlugin(sdk) {
  const start = (ctx, request, sink) => cliSessionRun(sdk, ctx, VibeHarness, "vibe", request, sink);
  return {
    apiVersion: 1,
    id: "vibe",
    displayName: "Vibe",
    capabilities: { resume: true, systemPrompt: "none", nativeTimeLimit: true, providers: false },
    probe: () => probeCli(sdk, { versionCmd: ["vibe", "--version"], loginHint: LOGIN_HINT }),
    listModels: async (ctx) => vibeModelChoices(ctx.env),
    startSession: start,
    resumeSession: start,
    // vibe has no session reader today.
    readTranscript: async () => null,
  };
};
