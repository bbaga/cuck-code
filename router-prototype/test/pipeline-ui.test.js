"use strict";
const test = require("node:test");
const assert = require("node:assert");
const {
  PHASE_ROWS,
  EFFORT_LEVELS,
  filterInstalled,
  buildPipelinePayload,
  authBadge,
} = require("../web/pipeline-ui.js");

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
