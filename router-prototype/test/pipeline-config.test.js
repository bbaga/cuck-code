"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readClaudeConfig } = require("../claude-config");
const {
  PHASES,
  HARNESS_IDS,
  EFFORT_LEVELS,
  fallbackPhaseSettings,
  HARNESS_PROBES,
  probeHarnesses,
  probeResultFor,
  parsePiModelCatalog,
  piAuthCheckArgs,
  parsePiAuthCheck,
  parseVibeModelsEnv,
  vibeModelChoices,
  claudeModelChoices,
  piProviderDetail,
} = require("../pipeline-config");

// ---- fallbackPhaseSettings (the phase view of a worker whose node is not in the graph) ----

const resolvePipeline = (line, env) => Object.fromEntries(
  PHASES.map((phase) => [phase, fallbackPhaseSettings(line || {}, phase, env)]));


test("fallbackPhaseSettings defaults equal today behavior", () => {
  const r = resolvePipeline({}, {});
  assert.deepStrictEqual(r.planner, {
    harness: "vibe", model: null, effort: "medium", timeLimit: 1800, maxContext: 150000 });
  assert.deepStrictEqual(r.implementor, {
    harness: "vibe", model: "glm-5-3-flash", effort: "medium", timeLimit: 3600, maxContext: 150000 });
  assert.deepStrictEqual(r.validator, {
    harness: "vibe", model: "glm-5-3", effort: "medium", timeLimit: 3600 });
  assert.deepStrictEqual(r.integration, {
    harness: "vibe", model: "glm-5-3", effort: "medium", timeLimit: 3600 });
  assert.deepStrictEqual(Object.keys(r), PHASES);
});

test("fallbackPhaseSettings reads env time limits at resolve time", () => {
  const r = resolvePipeline({}, { PLANNER_TIME_LIMIT: "99", WORKER_TIME_LIMIT: "77" });
  assert.strictEqual(r.planner.timeLimit, 99);
  assert.strictEqual(r.implementor.timeLimit, 77);
  assert.strictEqual(r.validator.timeLimit, 77);
  assert.strictEqual(r.integration.timeLimit, 77);
});

test("fallbackPhaseSettings applies env overrides per phase", () => {
  const env = {
    PLANNER_HARNESS: "pi",
    IMPLEMENTOR_MODEL: "impl-x",
    VALIDATOR_EFFORT: "high",
    INTEGRATION_HARNESS: "codex",
    INTEGRATION_MODEL: "int-x",
    PLANNER_EFFORT: "low",
  };
  const r = resolvePipeline({}, env);
  assert.strictEqual(r.planner.harness, "pi");
  assert.strictEqual(r.planner.effort, "low");
  assert.strictEqual(r.implementor.model, "impl-x");
  assert.strictEqual(r.validator.effort, "high");
  assert.strictEqual(r.integration.harness, "codex");
  assert.strictEqual(r.integration.model, "int-x");
  // untouched fields keep defaults
  assert.strictEqual(r.planner.model, null);
  assert.strictEqual(r.validator.model, "glm-5-3");
});

test("fallbackPhaseSettings applies node settings over env", () => {
  const line = lineWithGraph({ nodeSettings: { "backend-impl": { harness: "claude", model: "line-m" } } });
  const r = resolvePipeline(line, { IMPLEMENTOR_MODEL: "env-m", IMPLEMENTOR_HARNESS: "pi" });
  assert.strictEqual(r.implementor.harness, "claude");
  assert.strictEqual(r.implementor.model, "line-m");
});

test("fallbackPhaseSettings does not carry a model across harnesses", () => {
  const line = lineWithGraph({ nodeSettings: {
    planner: { harness: "claude" },
    "backend-impl": { harness: "claude" },
    "backend-val": { harness: "pi" },
  } });
  const r = resolvePipeline(line, { IMPLEMENTOR_MODEL: "env-m" });
  assert.strictEqual(r.planner.model, null);
  assert.strictEqual(r.implementor.model, null);
  assert.strictEqual(r.validator.model, null);
  assert.strictEqual(r.integration.model, "glm-5-3");
  // Env harness and env model stay paired; the vibe default does not leak.
  const e = resolvePipeline({}, { IMPLEMENTOR_HARNESS: "claude", IMPLEMENTOR_MODEL: "sonnet",
    VALIDATOR_HARNESS: "claude" });
  assert.strictEqual(e.implementor.model, "sonnet");
  assert.strictEqual(e.validator.model, null);
  // A line that names the env harness explicitly keeps the env model.
  const same = resolvePipeline(lineWithGraph({ nodeSettings: { "backend-impl": { harness: "vibe" } } }),
    { IMPLEMENTOR_MODEL: "env-m" });
  assert.strictEqual(same.implementor.model, "env-m");
});

test("fallbackPhaseSettings merges per field: node settings set only model", () => {
  const line = lineWithGraph({ nodeSettings: { "backend-val": { model: "only-model" } } });
  const r = resolvePipeline(line, {});
  assert.strictEqual(r.validator.model, "only-model");
  assert.strictEqual(r.validator.harness, "vibe");
  assert.strictEqual(r.validator.effort, "medium");
  assert.strictEqual(r.validator.timeLimit, 3600);
});

test("fallbackPhaseSettings tolerates a missing line", () => {
  const r = resolvePipeline(null, {});
  assert.strictEqual(r.planner.harness, "vibe");
});

// ---- HARNESS_PROBES ----

test("HARNESS_PROBES covers every harness id", () => {
  assert.deepStrictEqual(HARNESS_PROBES.map((p) => p.id), HARNESS_IDS);
  for (const probe of HARNESS_PROBES) {
    assert.ok(Array.isArray(probe.versionCmd) && probe.versionCmd.length >= 2);
    assert.ok(probe.authCmd === null || Array.isArray(probe.authCmd));
    assert.strictEqual(typeof probe.loginHint, "string");
    assert.ok(probe.loginHint.length > 0);
  }
});

test("pi probe has no provider-free auth check and lists models", () => {
  const pi = HARNESS_PROBES.find((p) => p.id === "pi");
  assert.strictEqual(pi.authCmd, null);
  assert.deepStrictEqual(pi.listModelsCmd, ["pi", "--list-models"]);
});

// ---- probeResultFor ----

test("probeResultFor returns the entry with the matching id", () => {
  const results = [{ id: "vibe", installed: true }, { id: "codex", installed: false }];
  assert.deepStrictEqual(probeResultFor(results, "codex"), { id: "codex", installed: false });
  assert.deepStrictEqual(probeResultFor(results, "vibe"), { id: "vibe", installed: true });
});

test("probeResultFor returns null for an unknown id", () => {
  const results = [{ id: "vibe", installed: true }];
  assert.strictEqual(probeResultFor(results, "gemini"), null);
});

test("probeResultFor returns null for an empty list", () => {
  assert.strictEqual(probeResultFor([], "vibe"), null);
});

// ---- Claude server reader and probe API ----

test("server Claude reader reads only the approved files", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-reader-"));
  try {
    fs.mkdirSync(path.join(home, ".claude", "cache"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ modelPicker: { options: [{ model: "kimi-k3", label: "Kimi K3" }] }, token: "secret" }));
    fs.writeFileSync(path.join(home, ".claude", "settings.local.json"), JSON.stringify({ modelPicker: { options: [{ model: "deepseek-v3", label: "DeepSeek V3" }] } }));
    fs.writeFileSync(path.join(home, ".claude", "cache", "gateway-models.json"), JSON.stringify({ models: [{ id: "kimi-k3", display_name: "Kimi K3" }] }));
    fs.writeFileSync(path.join(home, ".claude", "cache", "not-approved.json"), JSON.stringify({ models: [{ id: "wrong" }] }));
    const config = readClaudeConfig(home);
    assert.deepStrictEqual(config.settings.modelPicker.options[0], { model: "kimi-k3", label: "Kimi K3" });
    assert.deepStrictEqual(config.localSettings.modelPicker.options[0], { model: "deepseek-v3", label: "DeepSeek V3" });
    assert.deepStrictEqual(config.gatewayCache.models, [{ id: "kimi-k3", display_name: "Kimi K3" }]);
    assert.deepStrictEqual(claudeModelChoices(config).map((m) => m.value), ["opus", "sonnet", "haiku", "kimi-k3", "deepseek-v3"]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ---- probeHarnesses ----

function fakeRun(map) {
  return async (cmd) => {
    const key = cmd.join(" ");
    return key in map ? map[key] : null;
  };
}

test("probeHarnesses reports installed with version and auth ok", async () => {
  const run = fakeRun({
    "vibe --version": { code: 0, stdout: "vibe 3.0.2\nmore\n" },
    "pi --version": { code: 0, stdout: "0.87.1\n" },
    "pi --list-models": { code: 0, stdout: "Provider  Model\nanthropic  claude-x\n" },
  });
  const results = await probeHarnesses(run);
  const vibe = results.find((r) => r.id === "vibe");
  assert.strictEqual(vibe.installed, true);
  assert.strictEqual(vibe.auth, "unknown"); // vibe has no authCmd
  assert.strictEqual(vibe.version, "vibe 3.0.2");
  assert.strictEqual(vibe.loginHint, "vibe --setup");
  const pi = results.find((r) => r.id === "pi");
  assert.strictEqual(pi.installed, true);
  assert.strictEqual(pi.auth, "unknown"); // no provider-free auth check
  assert.strictEqual(pi.version, "0.87.1");
  assert.deepStrictEqual(pi.authModes, [{ value: "anthropic", label: "anthropic" }]);
  assert.deepStrictEqual(pi.models, [{ value: "anthropic/claude-x", label: "claude-x" }]);
});

test("probeHarnesses reports not installed and auth missing", async () => {
  const run = fakeRun({
    "codex --version": null,
    "codex login status": { code: 1, stdout: "" },
    "claude --version": { code: 0, stdout: "claude 2.0.0\n" },
    "claude auth status": null, // command cannot start
  });
  const results = await probeHarnesses(run);
  const codex = results.find((r) => r.id === "codex");
  assert.strictEqual(codex.installed, false);
  assert.strictEqual(codex.version, null);
  assert.strictEqual(codex.auth, "missing");
  const claude = results.find((r) => r.id === "claude");
  assert.strictEqual(claude.installed, true);
  assert.strictEqual(claude.auth, "unknown"); // run returned null for authCmd
  assert.strictEqual(claude.version, "claude 2.0.0");
});

test("probeHarnesses returns one entry per harness", async () => {
  const results = await probeHarnesses(async () => null);
  assert.deepStrictEqual(results.map((r) => r.id), HARNESS_IDS);
  for (const r of results) {
    assert.strictEqual(r.installed, false);
    assert.strictEqual(r.version, null);
  }
});

test("probeHarnesses never runs a provider-free pi auth check", async () => {
  const calls = [];
  await probeHarnesses(async (cmd) => { calls.push(cmd.join(" ")); return null; });
  assert.ok(!calls.some((c) => c.startsWith("pi auth check")),
    `unexpected provider-free pi auth call: ${calls.join("; ")}`);
  assert.ok(calls.includes("pi --list-models"));
});

test("probeHarnesses attaches vibe models from env and defaults", async () => {
  const results = await probeHarnesses(async () => null, {
    IMPLEMENTOR_MODEL: "impl-x",
    VIBE_MODELS: "extra-1, extra-1 ,,extra-2",
  });
  const vibe = results.find((r) => r.id === "vibe");
  assert.deepStrictEqual(vibe.models, [
    { value: "glm-5-3-flash", label: "glm-5-3-flash" },
    { value: "glm-5-3", label: "glm-5-3" },
    { value: "impl-x", label: "impl-x" },
    { value: "extra-1", label: "extra-1" },
    { value: "extra-2", label: "extra-2" },
  ]);
});

test("probeHarnesses preserves approved Claude source order and gateway suppression", async () => {
  const reader = async () => ({
    settings: { modelPicker: { options: [{ model: "local" }] } },
    localSettings: { modelPicker: { options: [{ value: "local-2", label: "Local 2" }] } },
    gatewayCache: { models: [
      { id: "kimi-k3", display_name: "Kimi K3" },
      { id: "deepseek-v3", display_name: "DeepSeek V3" },
      { id: "gateway-local", display_name: "local" },
    ] },
  });
  const results = await probeHarnesses(async () => null, {}, reader);
  assert.deepStrictEqual(results.find((r) => r.id === "claude").models, [
    { value: "opus", label: "opus" }, { value: "sonnet", label: "sonnet" },
    { value: "haiku", label: "haiku" }, { value: "local", label: "local" },
    { value: "local-2", label: "Local 2" }, { value: "kimi-k3", label: "Kimi K3" },
    { value: "deepseek-v3", label: "DeepSeek V3" },
  ]);
});

test("probeHarnesses reads Claude config and falls back on reader errors", async () => {
  const reader = async () => ({ settings: { modelPicker: { options: [{ model: "local" }] } } });
  const results = await probeHarnesses(async () => null, { ANTHROPIC_MODEL: "ignored" }, reader);
  assert.deepStrictEqual(results.find((r) => r.id === "claude").models.map((m) => m.value),
    ["opus", "sonnet", "haiku", "local"]);
  const fallback = await probeHarnesses(async () => null, {}, async () => { throw new Error("bad"); });
  assert.deepStrictEqual(fallback.find((r) => r.id === "claude").models.map((m) => m.value),
    ["opus", "sonnet", "haiku"]);
});

// ---- parsePiModelCatalog ----

test("parsePiModelCatalog parses a table with header and variable spacing", () => {
  const out = [
    "Provider   Model",
    "----------------",
    "anthropic    claude-sonnet-4",
    "openai\t\tgpt-5",
    "anthropic   claude-opus-4",
  ].join("\n");
  assert.deepStrictEqual(parsePiModelCatalog(out), {
    providers: [
      { value: "anthropic", label: "anthropic" },
      { value: "openai", label: "openai" },
    ],
    models: [
      { value: "anthropic/claude-sonnet-4", label: "claude-sonnet-4" },
      { value: "openai/gpt-5", label: "gpt-5" },
      { value: "anthropic/claude-opus-4", label: "claude-opus-4" },
    ],
  });
});

test("parsePiModelCatalog parses section headers with indented models", () => {
  const out = [
    "anthropic:",
    "  claude-sonnet-4",
    "  claude-opus-4",
    "openai:",
    "  gpt-5",
  ].join("\n");
  const parsed = parsePiModelCatalog(out);
  assert.deepStrictEqual(parsed.providers, [
    { value: "anthropic", label: "anthropic" },
    { value: "openai", label: "openai" },
  ]);
  assert.deepStrictEqual(parsed.models.map((m) => m.value),
    ["anthropic/claude-sonnet-4", "anthropic/claude-opus-4", "openai/gpt-5"]);
});

test("parsePiModelCatalog handles pipe tables and CRLF", () => {
  const out = "| provider | model |\r\n|---|---|\r\n| p1 | m1 |\r\n";
  assert.deepStrictEqual(parsePiModelCatalog(out), {
    providers: [{ value: "p1", label: "p1" }],
    models: [{ value: "p1/m1", label: "m1" }],
  });
});

test("parsePiModelCatalog handles empty output and failed commands", () => {
  assert.deepStrictEqual(parsePiModelCatalog(""), { providers: [], models: [] });
  assert.deepStrictEqual(parsePiModelCatalog("   \n\t\n"), { providers: [], models: [] });
  assert.deepStrictEqual(parsePiModelCatalog(null), { providers: [], models: [] });
  assert.deepStrictEqual(parsePiModelCatalog(undefined), { providers: [], models: [] });
});

test("parsePiModelCatalog ignores junk lines without a model column", () => {
  const parsed = parsePiModelCatalog("BANNER\n\np1 m1\n");
  assert.deepStrictEqual(parsed.providers, [{ value: "p1", label: "p1" }]);
  assert.deepStrictEqual(parsed.models, [{ value: "p1/m1", label: "m1" }]);
});

// ---- regression: the real six-column catalog must parse ----

test("parsePiModelCatalog parses the real pi catalog table with metadata columns", () => {
  // Byte-for-byte shape of `pi --list-models` on a real install: the model
  // id can itself be provider-qualified and the table carries context,
  // max-out, thinking, and images columns after the model.
  const out = [
    "provider      model               context  max-out  thinking  images",
    "lmstudio      google/gemma-4-e4b  50K      131.1K   yes       yes   ",
    "ollama-local  gemma4:e4b          230K     18.2K    no        no    ",
    "openai-codex  gpt-5.6-luna        272K     128K     yes       yes   ",
    "openai-codex  gpt-5.6-sol         272K     128K     yes       yes   ",
  ].join("\n");
  assert.deepStrictEqual(parsePiModelCatalog(out), {
    providers: [
      { value: "lmstudio", label: "lmstudio" },
      { value: "ollama-local", label: "ollama-local" },
      { value: "openai-codex", label: "openai-codex" },
    ],
    models: [
      { value: "lmstudio/google/gemma-4-e4b", label: "google/gemma-4-e4b" },
      { value: "ollama-local/gemma4:e4b", label: "gemma4:e4b" },
      { value: "openai-codex/gpt-5.6-luna", label: "gpt-5.6-luna" },
      { value: "openai-codex/gpt-5.6-sol", label: "gpt-5.6-sol" },
    ],
  });
});

test("parsePiModelCatalog ignores a wider row that misses the header width", () => {
  const out = [
    "provider  model",
    "p1  m1  extra",
    "p2  m2",
  ].join("\n");
  const parsed = parsePiModelCatalog(out);
  assert.deepStrictEqual(parsed.providers, [{ value: "p2", label: "p2" }]);
  assert.deepStrictEqual(parsed.models, [{ value: "p2/m2", label: "m2" }]);
});


test("parsePiModelCatalog rejects error prose passed directly", () => {
  for (const prose of [
    "Failed to load catalog",
    "Command failed",
    "Error: connection refused",
    "Error:",
    "no models found",
    "p1 m1 extra", // three cells: prose, not a row
  ]) {
    const parsed = parsePiModelCatalog(prose);
    assert.deepStrictEqual(parsed, { providers: [], models: [] },
      `prose must not parse: ${prose}`);
  }
});

test("parsePiModelCatalog still parses real rows next to prose", () => {
  const parsed = parsePiModelCatalog([
    "Failed to load catalog",
    "",
    "anthropic  claude-sonnet-4",
  ].join("\n"));
  assert.deepStrictEqual(parsed.providers, [{ value: "anthropic", label: "anthropic" }]);
  assert.deepStrictEqual(parsed.models,
    [{ value: "anthropic/claude-sonnet-4", label: "claude-sonnet-4" }]);
});

test("probeHarnesses yields no providers when the catalog command fails", async () => {
  const run = fakeRun({
    "pi --version": { code: 0, stdout: "0.87.1\n" },
    // Failed command WITH output: the prose must not become rows.
    "pi --list-models": { code: 1, stdout: "Failed to load catalog\n" },
  });
  const results = await probeHarnesses(run);
  const pi = results.find((r) => r.id === "pi");
  assert.strictEqual(pi.installed, true);
  assert.deepStrictEqual(pi.authModes, []);
  assert.deepStrictEqual(pi.models, []);
});

test("probeHarnesses yields no providers when the catalog command cannot start", async () => {
  const results = await probeHarnesses(fakeRun({}));
  const pi = results.find((r) => r.id === "pi");
  assert.deepStrictEqual(pi.authModes, []);
  assert.deepStrictEqual(pi.models, []);
});

// ---- piAuthCheckArgs / parsePiAuthCheck ----

test("piAuthCheckArgs builds an argument array, not a shell string", () => {
  assert.deepStrictEqual(piAuthCheckArgs("anthropic"),
    ["pi", "auth", "check", "--provider", "anthropic", "--json"]);
});

test("parsePiAuthCheck extracts only the login hint", () => {
  assert.deepStrictEqual(
    parsePiAuthCheck('{"loginHint":"run pi /login","token":"secret"}'),
    { loginHint: "run pi /login" });
  assert.deepStrictEqual(parsePiAuthCheck('{"authenticated":true}'), { loginHint: null });
  assert.deepStrictEqual(parsePiAuthCheck("not json at all"), { loginHint: null });
  assert.deepStrictEqual(parsePiAuthCheck(""), { loginHint: null });
  assert.deepStrictEqual(parsePiAuthCheck(null), { loginHint: null });
});

test("parsePiAuthCheck truncates a long hint", () => {
  const parsed = parsePiAuthCheck(JSON.stringify({ loginHint: "x".repeat(500) }));
  assert.strictEqual(parsed.loginHint.length, 200);
});

// ---- parseVibeModelsEnv / vibeModelChoices ----

test("parseVibeModelsEnv splits on commas and ignores empty values", () => {
  assert.deepStrictEqual(parseVibeModelsEnv("a, b ,,c"), ["a", "b", "c"]);
  assert.deepStrictEqual(parseVibeModelsEnv(","), []);
  assert.deepStrictEqual(parseVibeModelsEnv(""), []);
  assert.deepStrictEqual(parseVibeModelsEnv(undefined), []);
  assert.deepStrictEqual(parseVibeModelsEnv(5), []);
});

test("vibeModelChoices deduplicates defaults, env values, and VIBE_MODELS", () => {
  const env = {
    PLANNER_MODEL: "glm-5-3", // duplicates a default
    IMPLEMENTOR_MODEL: "impl-x",
    VIBE_ACTIVE_MODEL: "impl-x", // duplicate
    VIBE_MODELS: "extra-1, ,extra-2,impl-x",
  };
  assert.deepStrictEqual(vibeModelChoices(env), [
    { value: "glm-5-3-flash", label: "glm-5-3-flash" },
    { value: "glm-5-3", label: "glm-5-3" },
    { value: "impl-x", label: "impl-x" },
    { value: "extra-1", label: "extra-1" },
    { value: "extra-2", label: "extra-2" },
  ]);
});

test("vibeModelChoices ignores empty and non-string values", () => {
  const env = { PLANNER_MODEL: "  ", IMPLEMENTOR_MODEL: "", VIBE_MODELS: " ,," };
  assert.deepStrictEqual(vibeModelChoices(env), [
    { value: "glm-5-3-flash", label: "glm-5-3-flash" },
    { value: "glm-5-3", label: "glm-5-3" },
  ]);
});

// ---- piProviderDetail ----

function piProbe(overrides = {}) {
  return {
    id: "pi",
    installed: true,
    auth: "unknown",
    loginHint: "pi /login (in the pi TUI)",
    authModes: [
      { value: "anthropic", label: "anthropic" },
      { value: "openai", label: "openai" },
    ],
    models: [
      { value: "anthropic/claude-x", label: "claude-x" },
      { value: "openai/gpt-5", label: "gpt-5" },
    ],
    ...overrides,
  };
}

test("piProviderDetail returns the fixed contract shape", async () => {
  const calls = [];
  const run = async (cmd) => { calls.push(cmd); return { code: 0, stdout: "{}" }; };
  const result = await piProviderDetail("anthropic", piProbe(), run);
  assert.strictEqual(result.error, undefined);
  assert.deepStrictEqual(result.detail, {
    id: "pi",
    authMode: "anthropic",
    auth: "ok",
    loginHint: "pi /login (in the pi TUI)",
    models: [{ value: "anthropic/claude-x", label: "claude-x" }],
  });
  // argument array, not a shell string
  assert.deepStrictEqual(calls, [["pi", "auth", "check", "--provider", "anthropic", "--json"]]);
});

test("piProviderDetail reports missing auth and a hint from the check output", async () => {
  const run = async () => ({ code: 1, stdout: '{"loginHint":"run pi /login now"}' });
  const result = await piProviderDetail("openai", piProbe(), run);
  assert.strictEqual(result.detail.auth, "missing");
  assert.strictEqual(result.detail.loginHint, "run pi /login now");
  assert.strictEqual(result.detail.authMode, "openai");
});

test("piProviderDetail reports unknown when the check cannot run", async () => {
  const run = async () => null;
  const result = await piProviderDetail("openai", piProbe(), run);
  assert.strictEqual(result.detail.auth, "unknown");
});

test("piProviderDetail rejects missing and unknown providers with an error", async () => {
  const run = async () => { throw new Error("must not run"); };
  assert.match((await piProviderDetail(undefined, piProbe(), run)).error, /required/);
  assert.match((await piProviderDetail("  ", piProbe(), run)).error, /required/);
  assert.match((await piProviderDetail("gemini", piProbe(), run)).error,
    /unknown provider 'gemini'/);
  const noPi = await piProviderDetail("anthropic", piProbe({ installed: false, authModes: [] }), run);
  assert.match(noPi.error, /pi is not installed or reported no providers/);
});

test("piProviderDetail never leaks credentials or raw output", async () => {
  const run = async () => ({
    code: 0,
    stdout: '{"apiKey":"sk-secret","token":"hunter2","loginHint":"pi /login"}',
  });
  const result = await piProviderDetail("anthropic", piProbe(), run);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("sk-secret"));
  assert.ok(!serialized.includes("hunter2"));
});

// ---- resolveNodeSettings ----

const { loadBuiltinPipeline } = require("../line-graph");
const { resolveNodeSettings, validateNodeSettingsForNode } = require("../pipeline-config");

function lineWithGraph(extra) {
  const graph = loadBuiltinPipeline("default", fs, path.join(__dirname, ".."));
  return { graph: JSON.parse(JSON.stringify(graph)), ...extra };
}

test("resolveNodeSettings uses the env defaults of the phase of the node type", () => {
  const env = { IMPLEMENTOR_MODEL: "impl-m", VALIDATOR_EFFORT: "high", INTEGRATION_HARNESS: "codex",
    PLANNER_TIME_LIMIT: "99", WORKER_TIME_LIMIT: "77", COMPACT_AUTO_TOKENS: "50000" };
  const line = lineWithGraph();
  assert.strictEqual(resolveNodeSettings(line, "backend-impl", env).model, "impl-m");
  assert.strictEqual(resolveNodeSettings(line, "frontend-impl", env).model, "impl-m");
  assert.strictEqual(resolveNodeSettings(line, "backend-val", env).effort, "high");
  assert.strictEqual(resolveNodeSettings(line, "backend-val", env).model, "glm-5-3");
  const integ = resolveNodeSettings(line, "integration", env);
  assert.strictEqual(integ.harness, "codex");
  assert.strictEqual(integ.model, null);
  assert.strictEqual(integ.timeLimit, 77);
  const planner = resolveNodeSettings(line, "planner", env);
  assert.strictEqual(planner.timeLimit, 99);
  assert.strictEqual(planner.maxContext, 50000);
  assert.strictEqual(resolveNodeSettings(line, "backend-impl", env).maxContext, 50000);
});

test("resolveNodeSettings: file settings, then node settings win; env model needs the env harness", () => {
  const env = { IMPLEMENTOR_MODEL: "impl-m" };
  const line = lineWithGraph({ nodeSettings: { "frontend-impl": { effort: "low", harness: "pi" } } });
  line.graph.nodes["backend-impl"].settings = { effort: "high", model: "file-m" };
  line.graph.nodes["frontend-impl"].settings = { effort: "high", model: "file-m" };
  const be = resolveNodeSettings(line, "backend-impl", env);
  assert.strictEqual(be.effort, "high");
  assert.strictEqual(be.model, "file-m");
  const fe = resolveNodeSettings(line, "frontend-impl", env);
  assert.strictEqual(fe.effort, "low");
  assert.strictEqual(fe.harness, "pi");
  assert.strictEqual(fe.model, "file-m");
  line.nodeSettings["frontend-impl"].model = "node-m";
  assert.strictEqual(resolveNodeSettings(line, "frontend-impl", env).model, "node-m");
  delete line.graph.nodes["backend-impl"].settings.model;
  assert.strictEqual(resolveNodeSettings(line, "backend-impl", env).model, "impl-m");
  const switched = lineWithGraph({ nodeSettings: { "backend-impl": { harness: "pi" } } });
  assert.strictEqual(resolveNodeSettings(switched, "backend-impl", env).model, null);
  assert.throws(() => resolveNodeSettings(line, "nope", env), /no such node/);
});

test("maxContext is allowed only on a node with a resumed session", () => {
  const line = lineWithGraph();
  assert.strictEqual(validateNodeSettingsForNode(line.graph, "backend-impl", { maxContext: 5000 }), null);
  assert.strictEqual(validateNodeSettingsForNode(line.graph, "planner", { maxContext: 5000 }), null);
  assert.match(validateNodeSettingsForNode(line.graph, "backend-val", { maxContext: 5000 }),
    /maxContext is not supported/);
  assert.match(validateNodeSettingsForNode(line.graph, "integration", { maxContext: 5000 }),
    /maxContext is not supported/);
  line.nodeSettings = { "backend-val": { maxContext: 5000 } };
  assert.strictEqual("maxContext" in resolveNodeSettings(line, "backend-val", {}), false);
});
