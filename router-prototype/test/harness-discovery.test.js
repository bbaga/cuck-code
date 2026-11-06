"use strict";

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const registry = require("../harness-registry");
const { createSdk } = require("../harness-sdk");
const { registerBuiltins } = require("../harness-builtins");
const { probeHarnesses } = require("../pipeline-config");
const { PI_CATALOG } = require("./fixtures/fake-harness-clis");
const { discoverHarnesses } = require("../harness-discovery");

afterEach(() => registry.resetRegistryForTest());

function fakePlugin(id, overrides = {}) {
  return {
    apiVersion: 1, id,
    capabilities: { resume: true, systemPrompt: "none", nativeTimeLimit: false, providers: false },
    probe: async () => ({ installed: true, version: "1.0", auth: "ok", loginHint: "login" }),
    listModels: async () => [{ value: "m", label: "M" }],
    startSession() {}, resumeSession() {},
    ...overrides,
  };
}

function discover(timeoutMs) {
  const logs = [];
  const log = (level, event, data) => logs.push({ level, event, data });
  return discoverHarnesses({ sdk: {}, env: { A: "1" }, log, timeoutMs })
    .then((harnesses) => ({ harnesses, logs }));
}

test("a registered plugin appears with plugin, displayName and models", async () => {
  registry.registerHarness(fakePlugin("remote", { displayName: "Remote" }),
    { layer: "user", folder: "/p/remote" });
  const { harnesses } = await discover();
  assert.deepEqual(harnesses, [{
    id: "remote", installed: true, auth: "ok", loginHint: "login", version: "1.0",
    models: [{ value: "m", label: "M" }],
    displayName: "Remote",
    capabilities: fakePlugin("x").capabilities,
    plugin: { layer: "user", folder: "/p/remote" },
  }]);
});

test("a throwing probe gives installed false and a log line", async () => {
  registry.registerHarness(fakePlugin("broken", {
    probe: async () => { throw new Error("boom"); },
  }), { layer: "user", folder: "/p" });
  const { harnesses, logs } = await discover();
  assert.equal(harnesses[0].installed, false);
  assert.equal(harnesses[0].version, null);
  assert.equal(harnesses[0].auth, "unknown");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].data.method, "probe");
  assert.equal(logs[0].data.plugin, "broken");
  assert.match(logs[0].data.error, /boom/);
});

test("a slow probe times out", async () => {
  registry.registerHarness(fakePlugin("slow", { probe: () => new Promise(() => {}) }),
    { layer: "user", folder: "/p" });
  const { harnesses, logs } = await discover(20);
  assert.equal(harnesses[0].installed, false);
  assert.match(logs[0].data.error, /timed out/);
});

test("a failing listModels gives an empty list; providers list authModes", async () => {
  registry.registerHarness(fakePlugin("prov", {
    capabilities: { resume: false, systemPrompt: "none", nativeTimeLimit: false, providers: true },
    listModels: async () => { throw new Error("no models"); },
    listProviders: async () => [{ value: "p", label: "P" }],
    checkAuth: async () => ({ auth: "ok", loginHint: "" }),
  }), { layer: "user", folder: "/p" });
  const { harnesses } = await discover();
  assert.deepEqual(harnesses[0].models, []);
  assert.deepEqual(harnesses[0].authModes, [{ value: "p", label: "P" }]);
});

test("a bad probe result is normalized", async () => {
  registry.registerHarness(fakePlugin("odd", { probe: async () => ({ installed: "yes", auth: "x" }) }),
    { layer: "user", folder: "/p" });
  const { harnesses } = await discover();
  assert.equal(harnesses[0].installed, false);
  assert.equal(harnesses[0].auth, "unknown");
  assert.equal(harnesses[0].loginHint, "");
});

test("a built-in without model listing emits no models and no plugin key", async () => {
  registry.registerHarness(fakePlugin("codex"), { layer: "builtin", folder: "/b", builtIn: true });
  const { harnesses } = await discover();
  assert.equal("models" in harnesses[0], false);
  assert.equal("plugin" in harnesses[0], false);
});

test("built-in entry keys keep the old probe order; new keys follow", async () => {
  // Same fake CLIs for both paths: vibe and pi installed, codex and claude not.
  const run = async (cmd) => {
    if (cmd[0] === "vibe" && cmd[1] === "--version") return { code: 0, stdout: "vibe 3.0.2\n" };
    if (cmd[0] === "pi" && cmd[1] === "--version") return { code: 0, stdout: "pi 0.87.1\n" };
    if (cmd[0] === "pi" && cmd[1] === "--list-models") return { code: 0, stdout: PI_CATALOG };
    return null;
  };
  const sdk = createSdk({ runCommand: run, getBuiltin: (id) => registry.getHarness(id).plugin });
  registerBuiltins(registry, sdk);
  const old = await probeHarnesses(run, {}, async () => null);
  const { harnesses } = await discover();
  assert.equal(harnesses.length, 4);
  for (const entry of harnesses) {
    const oldKeys = Object.keys(old.find((o) => o.id === entry.id));
    assert.deepEqual(Object.keys(entry),
      [...oldKeys, "displayName", "capabilities"], `keys of ${entry.id}`);
  }
});

const { providerDetail } = require("../harness-discovery");

function providerPlugin(id, overrides = {}) {
  return fakePlugin(id, {
    capabilities: { resume: true, systemPrompt: "none", nativeTimeLimit: false, providers: true },
    listProviders: async () => [{ value: "acme", label: "Acme" }],
    listModels: async (ctx, query) => [{ value: `${query.provider}/m1`, label: "M1" }],
    checkAuth: async () => ({ auth: "ok", loginHint: "fresh hint" }),
    ...overrides,
  });
}

function detail(entry, provider, cached) {
  const logs = [];
  const log = (level, event, data) => logs.push({ level, event, data });
  return providerDetail({ entry, provider, cached, sdk: {}, env: {}, log })
    .then((result) => ({ result, logs }));
}

const CACHED = {
  id: "remote", installed: true, loginHint: "cached hint",
  authModes: [{ value: "acme", label: "Acme" }],
};

test("providerDetail returns the contract shape in key order", async () => {
  registry.registerHarness(providerPlugin("remote"), { layer: "user", folder: "/p/remote" });
  const { result } = await detail(registry.getHarness("remote"), " acme ", CACHED);
  assert.deepEqual(result, { detail: {
    id: "remote", authMode: "acme", auth: "ok", loginHint: "fresh hint",
    models: [{ value: "acme/m1", label: "M1" }],
  } });
  assert.deepEqual(Object.keys(result.detail),
    ["id", "authMode", "auth", "loginHint", "models"]);
});

test("providerDetail rejects a missing provider", async () => {
  registry.registerHarness(providerPlugin("remote"), { layer: "user", folder: "/p/remote" });
  for (const value of [null, "", "   "]) {
    const { result } = await detail(registry.getHarness("remote"), value, CACHED);
    assert.deepEqual(result, { error: "provider query parameter is required" });
  }
});

test("providerDetail names the known providers or the harness id", async () => {
  registry.registerHarness(providerPlugin("remote"), { layer: "user", folder: "/p/remote" });
  const entry = registry.getHarness("remote");
  assert.deepEqual((await detail(entry, "nope", CACHED)).result,
    { error: "unknown provider 'nope' (known providers: acme)" });
  assert.deepEqual((await detail(entry, "nope", { ...CACHED, authModes: [] })).result,
    { error: "unknown provider 'nope': remote is not installed or reported no providers" });
});

test("providerDetail skips checkAuth when not installed", async () => {
  let called = false;
  registry.registerHarness(providerPlugin("remote", {
    checkAuth: async () => { called = true; return { auth: "ok", loginHint: "x" }; },
  }), { layer: "user", folder: "/p/remote" });
  const { result } = await detail(registry.getHarness("remote"), "acme",
    { ...CACHED, installed: false });
  assert.equal(called, false);
  assert.equal(result.detail.auth, "unknown");
  assert.equal(result.detail.loginHint, "cached hint");
});

test("providerDetail survives a throwing checkAuth and listModels", async () => {
  registry.registerHarness(providerPlugin("remote", {
    listModels: async () => { throw new Error("boom"); },
    checkAuth: async () => { throw new Error("boom"); },
  }), { layer: "user", folder: "/p/remote" });
  const { result, logs } = await detail(registry.getHarness("remote"), "acme", CACHED);
  assert.deepEqual(result.detail,
    { id: "remote", authMode: "acme", auth: "unknown", loginHint: "cached hint", models: [] });
  assert.equal(logs.length, 2);
});

// Route errors, against the real router process. Built-ins only.
test("GET /api/harnesses/:id gives 404 for an unknown id and 400 without providers", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { startRouter, stopRouter } = require("./fixtures/router-process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "provider-detail-test-"));
  const router = await startRouter(path.join(tmp, "lines"), {});
  try {
    const get = async (p) => {
      const res = await fetch(router.base + p);
      return { status: res.status, body: await res.json() };
    };
    assert.deepEqual(await get("/api/harnesses/nope?provider=x"),
      { status: 404, body: { error: "unknown harness 'nope'" } });
    assert.deepEqual(await get("/api/harnesses/Bad_Id?provider=x"),
      { status: 404, body: { error: "unknown harness 'Bad_Id'" } });
    assert.deepEqual(await get("/api/harnesses/vibe?provider=x"),
      { status: 400, body: { error: "harness 'vibe' has no providers" } });
  } finally {
    await stopRouter(router);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
