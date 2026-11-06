"use strict";

// Built-in pi harness (pi coding agent CLI). Supports several providers.

const { PiHarness } = require("../../harness");
const {
  HARNESS_PROBES, parsePiModelCatalog, piAuthCheckArgs, parsePiAuthCheck,
} = require("../../pipeline-config");
const { findSession, readSession } = require("../../transcript-history");
const { cliSessionRun, probeCli } = require("../shared/cli-plugin");

const PI_PROBE = HARNESS_PROBES.find((p) => p.id === "pi");

module.exports = function createHarnessPlugin(sdk) {
  const start = (ctx, request, sink) => cliSessionRun(sdk, ctx, PiHarness, "pi", request, sink);

  // One catalog command per call. A failed command gives an empty catalog,
  // whatever it printed: error prose must never become a catalog row.
  async function runCatalog() {
    const res = await sdk.runCommand(PI_PROBE.listModelsCmd);
    return res && res.code === 0 ? parsePiModelCatalog(res.stdout) : { providers: [], models: [] };
  }

  // Discovery calls listProviders and listModels with one ctx. The memo,
  // keyed by that ctx, keeps the catalog command at one run per discovery.
  const catalogByCtx = new WeakMap();
  function readCatalog(ctx) {
    if (!ctx || typeof ctx !== "object") return runCatalog();
    if (!catalogByCtx.has(ctx)) catalogByCtx.set(ctx, runCatalog());
    return catalogByCtx.get(ctx);
  }

  return {
    apiVersion: 1,
    id: "pi",
    displayName: "Pi",
    capabilities: { resume: true, systemPrompt: "file", nativeTimeLimit: false, providers: true },
    // No provider-free auth check exists, so auth stays "unknown" by design.
    probe: () => probeCli(sdk, { versionCmd: PI_PROBE.versionCmd, loginHint: PI_PROBE.loginHint }),
    async listProviders(ctx) {
      return (await readCatalog(ctx)).providers;
    },
    async listModels(ctx, query) {
      const { models } = await readCatalog(ctx);
      const provider = query && typeof query.provider === "string" ? query.provider.trim() : "";
      return provider ? models.filter((m) => m.value.startsWith(`${provider}/`)) : models;
    },
    async checkAuth(ctx, { provider }) {
      let auth = "unknown";
      let loginHint = PI_PROBE.loginHint;
      const res = await sdk.runCommand(piAuthCheckArgs(provider));
      if (res) {
        auth = res.code === 0 ? "ok" : "missing";
        const parsed = parsePiAuthCheck(res.stdout);
        if (parsed.loginHint) loginHint = parsed.loginHint;
      }
      // Only these two fields leave: never raw output or credentials.
      return { auth, loginHint };
    },
    startSession: start,
    resumeSession: start,
    async readTranscript(ctx, { sessionId, workdir }) {
      const file = await findSession({ harness: "pi", sessionId, workdir }, ctx.env);
      return file ? readSession(file, "pi", sessionId) : null;
    },
  };
};
