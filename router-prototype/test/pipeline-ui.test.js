"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  PHASE_ROWS,
  EFFORT_LEVELS,
  PI_HARNESS_ID,
  VIBE_HARNESS_ID,
  filterInstalled,
  findHarness,
  normalizeOptions,
  mergeModelOptions,
  parseCommaSeparatedModels,
  authModeOptions,
  baseModelOptions,
  piDetailModels,
  modelOptionsForPhase,
  piDetailUrl,
  authModeSelectState,
  piDetailApply,
  piAuthStatusText,
  createRequestTracker,
  fetchPiDetail,
  clearHarnessState,
  clearProviderState,
  buildPipelinePayload,
  authBadge,
} = require("../web/pipeline-ui.js");
const pipelineUiModule = require("../web/pipeline-ui.js");

test("PHASE_ROWS lists the four pipeline phases", () => {
  assert.deepEqual(
    PHASE_ROWS.map((r) => r.key),
    ["planner", "implementor", "validator", "integration"],
  );
});

test("EFFORT_LEVELS lists low, medium, high", () => {
  assert.deepEqual(EFFORT_LEVELS, ["low", "medium", "high"]);
});

test("filterInstalled keeps only installed entries", () => {
  const harnesses = [
    { id: "vibe", installed: true, auth: "ok" },
    { id: "pi", installed: true, auth: "missing" },
    { id: "codex", installed: false, auth: "unknown" },
    { id: "claude", installed: false, auth: "missing" },
  ];
  assert.deepEqual(filterInstalled(harnesses).map((h) => h.id), ["vibe", "pi"]);
});

test("filterInstalled tolerates missing or malformed input", () => {
  assert.deepEqual(filterInstalled(undefined), []);
  assert.deepEqual(filterInstalled(null), []);
  assert.deepEqual(filterInstalled([null, { id: "x" }]), []);
});

test("buildPipelinePayload returns null for all-empty input", () => {
  const rows = {};
  for (const { key } of PHASE_ROWS) {
    rows[key] = { harness: "", model: "", effort: "" };
  }
  assert.strictEqual(buildPipelinePayload(rows), null);
});

test("buildPipelinePayload returns null for empty input object", () => {
  assert.strictEqual(buildPipelinePayload({}), null);
  assert.strictEqual(buildPipelinePayload(null), null);
});

test("buildPipelinePayload omits empty fields and phases", () => {
  const rows = {
    planner: { harness: "vibe", model: "", effort: "high" },
    implementor: { harness: "", model: "glm-5-3", effort: "" },
    validator: { harness: "", model: "", effort: "" },
    integration: { harness: "pi", model: "", effort: "low" },
  };
  assert.deepEqual(buildPipelinePayload(rows), {
    planner: { harness: "vibe", effort: "high" },
    implementor: { model: "glm-5-3" },
    integration: { harness: "pi", effort: "low" },
  });
});

test("buildPipelinePayload keeps a phase with only one field", () => {
  const rows = {
    planner: { harness: "", model: "", effort: "" },
    implementor: { harness: "", model: "", effort: "" },
    validator: { harness: "", model: "m", effort: "" },
    integration: { harness: "", model: "", effort: "" },
  };
  assert.deepEqual(buildPipelinePayload(rows), { validator: { model: "m" } });
});

test("authBadge returns the four states", () => {
  assert.strictEqual(authBadge({ installed: true, auth: "ok" }), "ok");
  assert.strictEqual(authBadge({ installed: true, auth: "missing" }), "missing");
  assert.strictEqual(authBadge({ installed: true, auth: "unknown" }), "unknown");
  assert.strictEqual(authBadge({ installed: false, auth: "ok" }), "not installed");
  assert.strictEqual(authBadge(undefined), "not installed");
});

test("PI_HARNESS_ID and VIBE_HARNESS_ID are stable", () => {
  assert.strictEqual(PI_HARNESS_ID, "pi");
  assert.strictEqual(VIBE_HARNESS_ID, "vibe");
});

test("findHarness returns the matching entry or null", () => {
  const harnesses = [{ id: "vibe", installed: true }, { id: "pi", installed: true }];
  assert.strictEqual(findHarness(harnesses, "pi"), harnesses[1]);
  assert.strictEqual(findHarness(harnesses, "codex"), null);
  assert.strictEqual(findHarness(undefined, "pi"), null);
  assert.strictEqual(findHarness(harnesses, undefined), null);
});

test("normalizeOptions keeps value and label pairs", () => {
  assert.deepEqual(
    normalizeOptions([{ value: "openai", label: "OpenAI" }, { value: "anthropic", label: "Anthropic" }]),
    [{ value: "openai", label: "OpenAI" }, { value: "anthropic", label: "Anthropic" }],
  );
});

test("normalizeOptions drops empty, malformed, and duplicate entries", () => {
  assert.deepEqual(
    normalizeOptions([
      { value: "", label: "empty" },
      { value: "  ", label: "blank" },
      null,
      { label: "no value" },
      { value: "a" },
      { value: "a", label: "again" },
      { value: "b", label: "  " },
    ]),
    [{ value: "a", label: "a" }, { value: "b", label: "b" }],
  );
});

test("normalizeOptions accepts plain strings and tolerates bad input", () => {
  assert.deepEqual(normalizeOptions(["x", " y "]), [{ value: "x", label: "x" }, { value: "y", label: "y" }]);
  assert.deepEqual(normalizeOptions(undefined), []);
  assert.deepEqual(normalizeOptions("nope"), []);
  assert.deepEqual(normalizeOptions([42]), []);
});

test("mergeModelOptions keeps the first occurrence of each value", () => {
  assert.deepEqual(
    mergeModelOptions(
      [{ value: "vibe/m1", label: "m1" }],
      [{ value: "vibe/m1", label: "dup" }, { value: "vibe/m2", label: "m2" }],
    ),
    [{ value: "vibe/m1", label: "m1" }, { value: "vibe/m2", label: "m2" }],
  );
});

test("parseCommaSeparatedModels splits, trims, and drops empties", () => {
  assert.deepEqual(
    parseCommaSeparatedModels("vibe/m1, vibe/m2 ,,vibe/m3,"),
    [
      { value: "vibe/m1", label: "vibe/m1" },
      { value: "vibe/m2", label: "vibe/m2" },
      { value: "vibe/m3", label: "vibe/m3" },
    ],
  );
  assert.deepEqual(parseCommaSeparatedModels(""), []);
  assert.deepEqual(parseCommaSeparatedModels(undefined), []);
  assert.deepEqual(parseCommaSeparatedModels(42), []);
});

test("authModeOptions reads the Pi authModes list", () => {
  const harnesses = [
    { id: "pi", installed: true, authModes: [{ value: "openai", label: "OpenAI" }] },
    { id: "vibe", installed: true },
  ];
  assert.deepEqual(authModeOptions(harnesses, "pi"), [{ value: "openai", label: "OpenAI" }]);
  assert.deepEqual(authModeOptions(harnesses, "vibe"), []);
  assert.deepEqual(authModeOptions([], "pi"), []);
  assert.deepEqual(authModeOptions(undefined, "pi"), []);
});

test("baseModelOptions reads models and merges modelsEnv extras", () => {
  const harnesses = [
    { id: "vibe", installed: true, models: [{ value: "vibe/m1", label: "m1" }], modelsEnv: "vibe/m2" },
    { id: "pi", installed: true },
  ];
  assert.deepEqual(baseModelOptions(harnesses, "vibe"), [
    { value: "vibe/m1", label: "m1" },
    { value: "vibe/m2", label: "vibe/m2" },
  ]);
  assert.deepEqual(baseModelOptions(harnesses, "pi"), []);
});

test("piDetailModels normalizes the detail response models", () => {
  assert.deepEqual(
    piDetailModels({ id: "pi", authMode: "openai", models: [{ value: "openai/gpt-5", label: "gpt-5" }] }),
    [{ value: "openai/gpt-5", label: "gpt-5" }],
  );
  assert.deepEqual(piDetailModels(null), []);
  assert.deepEqual(piDetailModels({}), []);
});

test("modelOptionsForPhase returns Pi detail models only after a mode selection", () => {
  const detail = { id: "pi", authMode: "openai", models: [{ value: "openai/gpt-5", label: "gpt-5" }] };
  assert.deepEqual(
    modelOptionsForPhase({ harnesses: [], harnessId: "pi", piDetail: detail }),
    [{ value: "openai/gpt-5", label: "gpt-5" }],
  );
  assert.deepEqual(modelOptionsForPhase({ harnesses: [], harnessId: "pi", piDetail: null }), []);
});

test("modelOptionsForPhase returns Vibe base models and nothing for other harnesses", () => {
  const harnesses = [
    { id: "vibe", installed: true, models: [{ value: "vibe/m1", label: "m1" }] },
  ];
  assert.deepEqual(
    modelOptionsForPhase({ harnesses, harnessId: "vibe", piDetail: null }),
    [{ value: "vibe/m1", label: "m1" }],
  );
  assert.deepEqual(modelOptionsForPhase({ harnesses, harnessId: "codex", piDetail: null }), []);
  assert.deepEqual(modelOptionsForPhase({ harnesses: [], harnessId: "vibe", piDetail: null }), []);
});

test("piDetailUrl encodes the provider query parameter", () => {
  assert.strictEqual(piDetailUrl("openai"), "/api/harnesses/pi?provider=openai");
  assert.strictEqual(piDetailUrl("a b&c"), "/api/harnesses/pi?provider=a%20b%26c");
});

test("piAuthStatusText describes auth state and login hint", () => {
  assert.strictEqual(
    piAuthStatusText({ auth: "ok", loginHint: "pi /login" }),
    "pi auth ok - pi /login",
  );
  assert.strictEqual(
    piAuthStatusText({ auth: "missing", loginHint: "pi /login (in the pi TUI)" }),
    "pi auth missing - run pi /login (in the pi TUI)",
  );
  assert.strictEqual(piAuthStatusText({ auth: "missing" }), "pi auth missing - run pi /login");
  assert.strictEqual(piAuthStatusText({ auth: "unknown", loginHint: "check pi" }), "pi auth unknown - check pi");
  assert.strictEqual(piAuthStatusText(null), "");
  assert.strictEqual(piAuthStatusText("nope"), "");
});

test("createRequestTracker invalidates older tokens", () => {
  const tracker = createRequestTracker();
  const first = tracker.next();
  assert.ok(tracker.isCurrent(first));
  const second = tracker.next();
  assert.ok(!tracker.isCurrent(first));
  assert.ok(tracker.isCurrent(second));
});

test("clearHarnessState resets everything but keeps the tracker", () => {
  const tracker = createRequestTracker();
  const state = clearHarnessState({
    tracker,
    authMode: "openai",
    model: "openai/gpt-5",
    models: [{ value: "openai/gpt-5", label: "gpt-5" }],
    piDetail: { auth: "ok" },
    statusText: "pi auth ok",
  });
  assert.strictEqual(state.tracker, tracker);
  assert.strictEqual(state.authMode, "");
  assert.strictEqual(state.model, "");
  assert.deepEqual(state.models, []);
  assert.strictEqual(state.piDetail, null);
  assert.strictEqual(state.statusText, "");
});

test("clearHarnessState creates a tracker when none exists", () => {
  const state = clearHarnessState(null);
  assert.ok(state.tracker && typeof state.tracker.next === "function");
  assert.strictEqual(state.authMode, "");
});

test("clearProviderState keeps the auth mode but drops provider state", () => {
  const tracker = createRequestTracker();
  const state = clearProviderState({
    tracker,
    authMode: "openai",
    model: "openai/gpt-5",
    models: [{ value: "openai/gpt-5", label: "gpt-5" }],
    piDetail: { auth: "ok" },
    statusText: "pi auth ok",
  });
  assert.strictEqual(state.tracker, tracker);
  assert.strictEqual(state.authMode, "openai");
  assert.strictEqual(state.model, "");
  assert.deepEqual(state.models, []);
  assert.strictEqual(state.piDetail, null);
  assert.strictEqual(state.statusText, "");
});

test("buildPipelinePayload keeps model as a string and omits empty values", () => {
  const rows = {
    planner: { harness: "pi", model: "openai/gpt-5", effort: "" },
    implementor: { harness: "vibe", model: "", effort: "high" },
    validator: { harness: "", model: "", effort: "" },
    integration: { harness: "", model: "", effort: "" },
  };
  assert.deepEqual(buildPipelinePayload(rows), {
    planner: { harness: "pi", model: "openai/gpt-5" },
    implementor: { harness: "vibe", effort: "high" },
  });
});

test("authModeSelectState resets a retained value on a non-Pi harness", () => {
  const state = authModeSelectState({
    harnessId: "vibe",
    options: [{ value: "openai", label: "OpenAI" }],
    currentValue: "openai",
  });
  assert.deepEqual(state, { hidden: true, disabled: true, options: [], value: "" });
});

test("authModeSelectState resets to the default for an empty harness", () => {
  const state = authModeSelectState({ harnessId: "", options: [], currentValue: "openai" });
  assert.deepEqual(state, { hidden: true, disabled: true, options: [], value: "" });
});

test("authModeSelectState keeps a valid Pi selection and drops an invalid one", () => {
  const options = [{ value: "openai", label: "OpenAI" }, { value: "anthropic", label: "Anthropic" }];
  assert.deepEqual(
    authModeSelectState({ harnessId: "pi", options, currentValue: "anthropic" }),
    { hidden: false, disabled: false, options, value: "anthropic" },
  );
  assert.deepEqual(
    authModeSelectState({ harnessId: "pi", options, currentValue: "gone" }),
    { hidden: false, disabled: false, options, value: "" },
  );
});

test("piDetailApply drops a stale error response", () => {
  const outcome = piDetailApply({
    isCurrent: false,
    ok: false,
    status: 400,
    data: { error: "unknown provider" },
  });
  assert.deepEqual(outcome, { apply: false });
});

test("piDetailApply drops a stale success response", () => {
  const outcome = piDetailApply({
    isCurrent: false,
    ok: true,
    status: 200,
    data: { id: "pi", auth: "ok", models: [{ value: "openai/gpt-5", label: "gpt-5" }] },
  });
  assert.deepEqual(outcome, { apply: false });
});

test("piDetailApply applies a current error response with its message", () => {
  const outcome = piDetailApply({
    isCurrent: true,
    ok: false,
    status: 400,
    data: { error: "unknown provider 'nope'" },
  });
  assert.deepEqual(outcome, {
    apply: true,
    statusText: "unknown provider 'nope'",
    models: [],
    piDetail: null,
  });
});

test("piDetailApply falls back to a status message without an error body", () => {
  const outcome = piDetailApply({ isCurrent: true, ok: false, status: 400, data: {} });
  assert.equal(outcome.apply, true);
  assert.equal(outcome.statusText, "Pi detail failed (HTTP 400)");
});

test("piDetailApply applies a current success response", () => {
  const detail = { id: "pi", authMode: "openai", auth: "ok", loginHint: "pi /login",
    models: [{ value: "openai/gpt-5", label: "gpt-5" }] };
  const outcome = piDetailApply({ isCurrent: true, ok: true, status: 200, data: detail });
  assert.equal(outcome.apply, true);
  assert.equal(outcome.statusText, "pi auth ok - pi /login");
  assert.deepEqual(outcome.models, [{ value: "openai/gpt-5", label: "gpt-5" }]);
  assert.strictEqual(outcome.piDetail, detail);
});

test("piDetailApply ignores a malformed success body", () => {
  assert.deepEqual(piDetailApply({ isCurrent: true, ok: true, status: 200, data: null }), { apply: false });
  assert.deepEqual(piDetailApply({ isCurrent: true, ok: true, status: 200, data: "nope" }), { apply: false });
});

test("fetchPiDetail drops a response that goes stale when fetch resolves", async () => {
  const tracker = createRequestTracker();
  const token = tracker.next();
  let jsonCalled = false;
  const response = {
    ok: true,
    status: 200,
    json: async () => {
      jsonCalled = true;
      return { models: [{ value: "openai/gpt-5", label: "gpt-5" }] };
    },
  };
  // The row selection changes exactly as the fetch resolves, before the
  // body parsing starts.
  const result = await fetchPiDetail({
    url: "/pi/detail",
    fetchImpl: async () => {
      tracker.next();
      return response;
    },
    isCurrent: (t) => tracker.isCurrent(t),
    token,
  });
  assert.equal(result.stage, "stale-after-fetch");
  assert.equal(jsonCalled, false);
});

test("fetchPiDetail parses and reports a current response", async () => {
  const tracker = createRequestTracker();
  const token = tracker.next();
  const result = await fetchPiDetail({
    url: "/pi/detail",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ auth: "ok" }) }),
    isCurrent: (t) => tracker.isCurrent(t),
    token,
  });
  assert.equal(result.stage, "parsed");
  assert.equal(result.current, true);
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { auth: "ok" });
});

test("fetchPiDetail reports a response that goes stale during body parsing", async () => {
  const tracker = createRequestTracker();
  const token = tracker.next();
  const result = await fetchPiDetail({
    url: "/pi/detail",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        tracker.next();
        return { auth: "ok" };
      },
    }),
    isCurrent: (t) => tracker.isCurrent(t),
    token,
  });
  assert.equal(result.stage, "parsed");
  assert.equal(result.current, false);
  assert.deepEqual(piDetailApply({ isCurrent: result.current, ok: result.ok, status: result.status, data: result.data }), {
    apply: false,
  });
});

test("fetchPiDetail reports a fetch error only when the token is current", async () => {
  const tracker = createRequestTracker();
  const token = tracker.next();
  const stale = await fetchPiDetail({
    url: "/pi/detail",
    fetchImpl: async () => {
      tracker.next();
      throw new Error("boom");
    },
    isCurrent: (t) => tracker.isCurrent(t),
    token,
  });
  assert.equal(stale.stage, "fetch-error");
  assert.equal(stale.current, false);
  const freshTracker = createRequestTracker();
  const freshToken = freshTracker.next();
  const fresh = await fetchPiDetail({
    url: "/pi/detail",
    fetchImpl: async () => {
      throw new Error("boom");
    },
    isCurrent: (t) => freshTracker.isCurrent(t),
    token: freshToken,
  });
  assert.equal(fresh.stage, "fetch-error");
  assert.equal(fresh.current, true);
  assert.match(fresh.error, /boom/);
});

test("pipeline-ui exports fetchPiDetail for the browser global and Node tests", () => {
  assert.equal(typeof pipelineUiModule.fetchPiDetail, "function");
});

test("index.html binds fetchPiDetail from window.pipelineUI", () => {
  const indexSource = fs.readFileSync(
    path.join(__dirname, "..", "web", "index.html"),
    "utf8",
  );
  const destructure = indexSource.match(
    /const\s*\{([\s\S]*?)\}\s*=\s*window\.pipelineUI;/,
  );
  assert.ok(destructure, "index.html destructures window.pipelineUI");
  const bound = new Set(
    destructure[1].split(",").map((name) => name.trim()).filter(Boolean),
  );
  assert.ok(bound.has("fetchPiDetail"), "fetchPiDetail must be bound");
});

test("index.html binds every pipelineUI helper its script uses", () => {
  const indexSource = fs.readFileSync(
    path.join(__dirname, "..", "web", "index.html"),
    "utf8",
  );
  const destructureMatch = indexSource.match(
    /const\s*\{([\s\S]*?)\}\s*=\s*window\.pipelineUI;/,
  );
  assert.ok(destructureMatch, "index.html destructures window.pipelineUI");
  const bound = new Set(
    destructureMatch[1].split(",").map((name) => name.trim()).filter(Boolean),
  );
  // Remove the destructure itself, then look for bare uses of exported names.
  const script = indexSource.replace(
    /const\s*\{[\s\S]*?\}\s*=\s*window\.pipelineUI;/,
    "",
  );
  const unbound = Object.keys(pipelineUiModule).filter(
    (name) => new RegExp("\\b" + name + "\\b").test(script) && !bound.has(name),
  );
  assert.deepEqual(unbound, []);
});
