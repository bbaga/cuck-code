"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const {
  API_VERSION, BUILTIN_HARNESS_IDS, SYSTEM_PROMPT_MODES, ID_RE,
  validateHarnessPlugin, normalizeChoices,
} = require("../harness-interface");

function validPlugin(over = {}) {
  return {
    apiVersion: 1,
    id: "remote-claude",
    displayName: "Remote Claude",
    capabilities: { resume: true, systemPrompt: "file", nativeTimeLimit: false, providers: false },
    probe: async () => ({}),
    listModels: async () => [],
    startSession: () => ({}),
    resumeSession: () => ({}),
    ...over,
  };
}

function errorsFor(over, opts) {
  return validateHarnessPlugin(validPlugin(over), opts);
}

function assertNames(errors, field) {
  assert.ok(errors.some((e) => e.includes(field)), `expected an error naming ${field}: ${JSON.stringify(errors)}`);
}

test("constants match the contract", () => {
  assert.strictEqual(API_VERSION, 1);
  assert.deepStrictEqual(BUILTIN_HARNESS_IDS, ["vibe", "pi", "codex", "claude"]);
  assert.deepStrictEqual(SYSTEM_PROMPT_MODES, ["file", "text", "none"]);
  assert.ok(ID_RE.test("a") && ID_RE.test("a-1") && !ID_RE.test("A") && !ID_RE.test("1a"));
  assert.ok(!ID_RE.test("a".repeat(65)));
});

test("a valid plugin has no errors", () => {
  assert.deepStrictEqual(errorsFor({}), []);
  assert.deepStrictEqual(errorsFor({ displayName: undefined }), []);
});

test("plugin must be a non-null object", () => {
  for (const bad of [null, undefined, 5, "x", []]) {
    assert.deepStrictEqual(validateHarnessPlugin(bad), ["plugin must be a non-null object"]);
  }
});

test("apiVersion must be 1", () => {
  assertNames(errorsFor({ apiVersion: 2 }), "apiVersion");
  assertNames(errorsFor({ apiVersion: undefined }), "apiVersion");
});

test("id must match the pattern", () => {
  assertNames(errorsFor({ id: "Bad_Id" }), "id");
  assertNames(errorsFor({ id: 7 }), "id");
});

test("id must equal expectId when given", () => {
  assert.deepStrictEqual(errorsFor({}, { expectId: "remote-claude" }), []);
  assertNames(errorsFor({}, { expectId: "other" }), "folder name");
});

test("reserved ids need builtIn", () => {
  assertNames(errorsFor({ id: "claude" }), "reserved");
  assert.deepStrictEqual(errorsFor({ id: "claude" }, { builtIn: true }), []);
});

test("displayName must be a non-empty string when present", () => {
  assertNames(errorsFor({ displayName: "" }), "displayName");
  assertNames(errorsFor({ displayName: "  " }), "displayName");
  assertNames(errorsFor({ displayName: 3 }), "displayName");
});

test("capabilities must be an object", () => {
  assertNames(errorsFor({ capabilities: null }), "capabilities");
  assertNames(errorsFor({ capabilities: [] }), "capabilities");
});

test("capabilities need exactly the known keys", () => {
  assertNames(errorsFor({ capabilities: { resume: true, systemPrompt: "none", nativeTimeLimit: false } }), "capabilities.providers");
  const extra = { resume: true, systemPrompt: "none", nativeTimeLimit: false, providers: false, extra: 1 };
  assertNames(errorsFor({ capabilities: extra }), "capabilities.extra");
});

test("capability flags must be booleans", () => {
  for (const key of ["resume", "nativeTimeLimit", "providers"]) {
    const caps = { resume: true, systemPrompt: "none", nativeTimeLimit: false, providers: false, [key]: "yes" };
    assertNames(errorsFor({ capabilities: caps }), `capabilities.${key}`);
  }
});

test("capabilities.systemPrompt must be a known mode", () => {
  const caps = { resume: true, systemPrompt: "stdin", nativeTimeLimit: false, providers: false };
  assertNames(errorsFor({ capabilities: caps }), "capabilities.systemPrompt");
  for (const mode of SYSTEM_PROMPT_MODES) {
    assert.deepStrictEqual(errorsFor({ capabilities: { ...caps, systemPrompt: mode } }), []);
  }
});

test("required methods must be functions", () => {
  for (const name of ["probe", "listModels", "startSession", "resumeSession"]) {
    assertNames(errorsFor({ [name]: undefined }), name);
    assertNames(errorsFor({ [name]: "x" }), name);
  }
});

test("provider methods are required only when providers is true", () => {
  const caps = { resume: true, systemPrompt: "none", nativeTimeLimit: false, providers: true };
  const errors = errorsFor({ capabilities: caps });
  assertNames(errors, "listProviders");
  assertNames(errors, "checkAuth");
  const ok = errorsFor({ capabilities: caps, listProviders: async () => [], checkAuth: async () => ({}) });
  assert.deepStrictEqual(ok, []);
  assert.deepStrictEqual(errorsFor({ listProviders: async () => [], checkAuth: async () => ({}) }), []);
});

test("readTranscript is optional but must be a function", () => {
  assert.deepStrictEqual(errorsFor({ readTranscript: async () => null }), []);
  assertNames(errorsFor({ readTranscript: "x" }), "readTranscript");
});

test("unknown top-level keys are errors", () => {
  assertNames(errorsFor({ surprise: true }), "surprise");
});

test("normalizeChoices accepts strings and objects", () => {
  assert.deepStrictEqual(normalizeChoices(["a", { value: "b", label: "B" }, { value: "c" }]), [
    { value: "a", label: "a" },
    { value: "b", label: "B" },
    { value: "c", label: "c" },
  ]);
});

test("normalizeChoices drops invalid items", () => {
  assert.deepStrictEqual(normalizeChoices(["", null, 4, {}, { value: 3 }, { label: "x" }, "ok"]), [
    { value: "ok", label: "ok" },
  ]);
});

test("normalizeChoices removes duplicates and keeps order", () => {
  assert.deepStrictEqual(normalizeChoices(["b", "a", { value: "b", label: "again" }, "a"]), [
    { value: "b", label: "b" },
    { value: "a", label: "a" },
  ]);
});

test("normalizeChoices returns [] for a non-array", () => {
  assert.deepStrictEqual(normalizeChoices(null), []);
  assert.deepStrictEqual(normalizeChoices("a"), []);
});
