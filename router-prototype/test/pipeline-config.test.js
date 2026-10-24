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
    "pi auth check": { code: 0, stdout: "ready\n" },
  });
  const results = await probeHarnesses(run);
  const vibe = results.find((r) => r.id === "vibe");
  assert.strictEqual(vibe.installed, true);
  assert.strictEqual(vibe.auth, "unknown"); // vibe has no authCmd
  assert.strictEqual(vibe.version, "vibe 3.0.2");
  assert.strictEqual(vibe.loginHint, "vibe --setup");
  const pi = results.find((r) => r.id === "pi");
  assert.strictEqual(pi.installed, true);
  assert.strictEqual(pi.auth, "ok");
  assert.strictEqual(pi.version, "0.87.1");
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
