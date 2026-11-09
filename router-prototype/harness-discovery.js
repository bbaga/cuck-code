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

// Detail for GET /api/harnesses/:id?provider=<p>. `cached` is the cached
// discovery result of the harness. The provider is checked against the
// cached authModes. Auth is checked per request, never cached, and only
// when the cached result says the harness is installed.
// -> { error } (HTTP 400) or { detail: { id, authMode, auth, loginHint, models } }.
async function providerDetail({ entry, provider, cached, sdk, env, log, timeoutMs = DISCOVERY_TIMEOUT_MS }) {
  const requested = typeof provider === "string" ? provider.trim() : "";
  if (!requested) return { error: "provider query parameter is required" };

  const { plugin } = entry;
  const authModes = cached && Array.isArray(cached.authModes) ? cached.authModes : [];
  if (!authModes.some((m) => m && m.value === requested)) {
    const known = authModes.map((m) => m && m.value).filter(Boolean).join(", ");
    return {
      error: known
        ? `unknown provider '${requested}' (known providers: ${known})`
        : `unknown provider '${requested}': ${plugin.id} is not installed or reported no providers`,
    };
  }

  const ctx = makeCtx(entry, { sdk, env, log });
  const listed = await guarded(ctx, entry, "listModels", [], timeoutMs,
    () => plugin.listModels(ctx, { provider: requested }));
  const models = Array.isArray(listed) ? listed : [];

  let auth = "unknown";
  let loginHint = (cached && cached.loginHint) || "";
  if (cached && cached.installed) {
    const checked = await guarded(ctx, entry, "checkAuth", null, timeoutMs,
      () => plugin.checkAuth(ctx, { provider: requested }));
    if (checked && typeof checked === "object") {
      if (["ok", "missing", "unknown"].includes(checked.auth)) auth = checked.auth;
      if (typeof checked.loginHint === "string" && checked.loginHint) loginHint = checked.loginHint;
    }
  }
  return { detail: { id: plugin.id, authMode: requested, auth, loginHint, models } };
}

module.exports = { discoverHarnesses, probeHarness, providerDetail, DISCOVERY_TIMEOUT_MS };
