"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const {
  PHASES,
  HARNESS_IDS,
  EFFORT_LEVELS,
  validatePipelineConfig,
  resolvePipeline,
  HARNESS_PROBES,
  probeHarnesses,
  probeResultFor,
  parsePiModelCatalog,
  piAuthCheckArgs,
  parsePiAuthCheck,
  parseVibeModelsEnv,
  vibeModelChoices,
  piProviderDetail,
} = require("../pipeline-config");

// ---- validatePipelineConfig ----

test("validatePipelineConfig accepts null and valid configs", () => {
  assert.strictEqual(validatePipelineConfig(null), null);
  assert.strictEqual(validatePipelineConfig(undefined), null);
  assert.strictEqual(validatePipelineConfig({}), null);
  assert.strictEqual(validatePipelineConfig({
    planner: { harness: "vibe", model: "m1", effort: "high", timeLimit: 60 },
    implementor: { harness: "pi" },
    validator: { model: "glm-5-3" },
    integration: { timeLimit: 120 },
  }), null);
});

test("validatePipelineConfig rejects non-object values", () => {
  assert.match(validatePipelineConfig("nope"), /must be an object/);
  assert.match(validatePipelineConfig(42), /must be an object/);
  assert.match(validatePipelineConfig([]), /must be an object/);
  assert.match(validatePipelineConfig({ planner: "vibe" }), /must be an object/);
  assert.match(validatePipelineConfig({ planner: null }), /must be an object/);
  assert.match(validatePipelineConfig({ planner: [] }), /must be an object/);
});

test("validatePipelineConfig rejects unknown phase keys and fields", () => {
  assert.match(validatePipelineConfig({ deploy: {} }), /unknown pipeline phase/);
  assert.match(validatePipelineConfig({ planner: { nope: 1 } }), /unknown field/);
});

test("validatePipelineConfig rejects unknown harnesses", () => {
  assert.match(validatePipelineConfig({ planner: { harness: "gemini" } }), /harness must be one of/);
});

test("validatePipelineConfig rejects empty and non-string models", () => {
  assert.match(validatePipelineConfig({ planner: { model: "" } }), /non-empty string/);
  assert.match(validatePipelineConfig({ planner: { model: "  " } }), /non-empty string/);
  assert.match(validatePipelineConfig({ planner: { model: 5 } }), /non-empty string/);
});

test("validatePipelineConfig rejects bad efforts", () => {
  assert.match(validatePipelineConfig({ planner: { effort: "ultra" } }), /effort must be one of/);
  assert.match(validatePipelineConfig({ planner: { effort: 2 } }), /effort must be one of/);
});

test("validatePipelineConfig rejects bad timeLimits", () => {
  assert.match(validatePipelineConfig({ planner: { timeLimit: 0 } }), /positive number/);
  assert.match(validatePipelineConfig({ planner: { timeLimit: -5 } }), /positive number/);
  assert.match(validatePipelineConfig({ planner: { timeLimit: "60" } }), /positive number/);
  assert.match(validatePipelineConfig({ planner: { timeLimit: Number.NaN } }), /positive number/);
});

test("validatePipelineConfig rejects authMode: model stays a string", () => {
  assert.match(
    validatePipelineConfig({ planner: { authMode: "anthropic" } }),
    /unknown field/);
  assert.strictEqual(validatePipelineConfig({ planner: { model: "provider/model" } }), null);
});

// ---- resolvePipeline ----

test("resolvePipeline defaults equal today behavior", () => {
  const r = resolvePipeline({}, {});
  assert.deepStrictEqual(r.planner, {
    harness: "vibe", model: null, effort: "medium", timeLimit: 1800 });
  assert.deepStrictEqual(r.implementor, {
    harness: "vibe", model: "glm-5-3-flash", effort: "medium", timeLimit: 3600 });
  assert.deepStrictEqual(r.validator, {
    harness: "vibe", model: "glm-5-3", effort: "medium", timeLimit: 3600 });
  assert.deepStrictEqual(r.integration, {
    harness: "vibe", model: "glm-5-3", effort: "medium", timeLimit: 3600 });
  assert.deepStrictEqual(Object.keys(r), PHASES);
});

test("resolvePipeline reads env time limits at resolve time", () => {
  const r = resolvePipeline({}, { PLANNER_TIME_LIMIT: "99", WORKER_TIME_LIMIT: "77" });
  assert.strictEqual(r.planner.timeLimit, 99);
  assert.strictEqual(r.implementor.timeLimit, 77);
  assert.strictEqual(r.validator.timeLimit, 77);
  assert.strictEqual(r.integration.timeLimit, 77);
});

test("resolvePipeline applies env overrides per phase", () => {
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

test("resolvePipeline applies line pipeline overrides over env", () => {
  const line = { pipeline: { implementor: { harness: "claude", model: "line-m" } } };
  const r = resolvePipeline(line, { IMPLEMENTOR_MODEL: "env-m", IMPLEMENTOR_HARNESS: "pi" });
  assert.strictEqual(r.implementor.harness, "claude");
  assert.strictEqual(r.implementor.model, "line-m");
});

test("resolvePipeline does not carry a model across harnesses", () => {
  const line = { pipeline: {
    planner: { harness: "claude" },
    implementor: { harness: "claude" },
    validator: { harness: "pi" },
  } };
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
  const same = resolvePipeline({ pipeline: { implementor: { harness: "vibe" } } },
    { IMPLEMENTOR_MODEL: "env-m" });
  assert.strictEqual(same.implementor.model, "env-m");
});

test("resolvePipeline merges per field: pipeline sets only model", () => {
  const line = { pipeline: { validator: { model: "only-model" } } };
  const r = resolvePipeline(line, {});
  assert.strictEqual(r.validator.model, "only-model");
  assert.strictEqual(r.validator.harness, "vibe");
  assert.strictEqual(r.validator.effort, "medium");
  assert.strictEqual(r.validator.timeLimit, 3600);
});

test("resolvePipeline tolerates a missing line", () => {
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

test("probeHarnesses attaches claude aliases and CLAUDE_MODELS", async () => {
  const results = await probeHarnesses(async () => null, {
    CLAUDE_MODELS: "claude-opus-5-5, sonnet,,claude-haiku-5-5",
  });
  const claude = results.find((r) => r.id === "claude");
  assert.deepStrictEqual(claude.models.map((m) => m.value),
    ["opus", "sonnet", "haiku", "claude-opus-5-5", "claude-haiku-5-5"]);
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
