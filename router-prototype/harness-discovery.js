"use strict";

// Discovery of the registered harnesses for GET /api/harnesses. Each plugin
// call has a timeout and a try/catch: one broken plugin never breaks the
// list. Harnesses run in parallel. One harness shares one ctx.

const { harnessEntries } = require("./harness-registry");
const { buildCtx } = require("./harness-runner");

const DISCOVERY_TIMEOUT_MS = 5000;

// Built-ins that listed models before the plugin interface existed.
// Plugins always list models.
const BUILTIN_WITH_MODELS = new Set(["vibe", "claude", "pi"]);

const UNKNOWN_PROBE = { installed: false, auth: "unknown", loginHint: "", version: null };

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Runs one plugin call. A throw, a rejection or a timeout gives `fallback`
// and one log line.
async function guarded(ctx, entry, method, fallback, timeoutMs, call) {
  try {
    return await withTimeout(Promise.resolve().then(call), timeoutMs, method);
  } catch (err) {
    ctx.log("warn", "harness_discovery_failed", {
      method, error: String((err && err.message) || err),
    });
    return fallback;
  }
}

function normalizeProbe(result) {
  if (!result || typeof result !== "object") return { ...UNKNOWN_PROBE };
  // Key order matches the old probe result: installed, auth, loginHint, version.
  return {
    installed: result.installed === true,
    auth: ["ok", "missing", "unknown"].includes(result.auth) ? result.auth : "unknown",
    loginHint: typeof result.loginHint === "string" ? result.loginHint : "",
    version: typeof result.version === "string" ? result.version : null,
  };
}

function makeCtx(entry, { sdk, env, log }) {
  return buildCtx({ entry, env, log, sdk });
}

// Probe only. Used where a fresh installed check is needed.
async function probeHarness(entry, { sdk, env, log, timeoutMs = DISCOVERY_TIMEOUT_MS }) {
  const ctx = makeCtx(entry, { sdk, env, log });
  const result = await guarded(ctx, entry, "probe", null, timeoutMs, () => entry.plugin.probe(ctx));
  return normalizeProbe(result);
}

async function discoverEntry(entry, options) {
  const { sdk, env, log, timeoutMs = DISCOVERY_TIMEOUT_MS } = options;
  const { plugin } = entry;
  const ctx = makeCtx(entry, { sdk, env, log });
  const providers = Boolean(plugin.capabilities && plugin.capabilities.providers);
  const wantModels = !entry.builtIn || BUILTIN_WITH_MODELS.has(plugin.id);

  // The probe runs first, then the list calls run in parallel. A plugin CLI
  // then never gets its version and catalog commands at the same time, as
  // before (the fake pi CLI log interleaves concurrent calls).
  const probe = await guarded(ctx, entry, "probe", null, timeoutMs, () => plugin.probe(ctx));
  const [models, authModes] = await Promise.all([
    wantModels
      ? guarded(ctx, entry, "listModels", [], timeoutMs, () => plugin.listModels(ctx, {}))
      : null,
    providers
      ? guarded(ctx, entry, "listProviders", [], timeoutMs, () => plugin.listProviders(ctx))
      : null,
  ]);

  const result = { id: plugin.id, ...normalizeProbe(probe) };
  // authModes before models: the old pi probe result had this order.
  if (providers) result.authModes = Array.isArray(authModes) ? authModes : [];
  if (wantModels) result.models = Array.isArray(models) ? models : [];
  result.displayName = plugin.displayName || plugin.id;
  result.capabilities = plugin.capabilities;
  if (!entry.builtIn) result.plugin = { layer: entry.layer, folder: entry.folder };
  return result;
}

// -> one result per registered harness, in registry order.
function discoverHarnesses({ sdk, env, log, timeoutMs }) {
  return Promise.all(harnessEntries().map(
    (entry) => discoverEntry(entry, { sdk, env, log, timeoutMs }),
  ));
}

module.exports = { discoverHarnesses, probeHarness, DISCOVERY_TIMEOUT_MS };
