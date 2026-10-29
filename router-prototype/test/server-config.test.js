"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { phaseForWorker, resolveWorkerOverrides, validateWorkerSpawnBody,
  lineSummary } = require("../spawn-plan");

test("phase selection per role and kind", () => {
  assert.equal(phaseForWorker("validator", "integration"), "integration");
  assert.equal(phaseForWorker("validator", "standard"), "validator");
  assert.equal(phaseForWorker("validator", undefined), "validator");
  assert.equal(phaseForWorker("implementor", "standard"), "implementor");
  assert.equal(phaseForWorker("implementor", "integration"), "implementor");
});

test("per-worker override wins over the phase config", () => {
  const cfg = { harness: "vibe", model: "glm-5-3-flash", effort: "medium" };
  assert.deepEqual(
    resolveWorkerOverrides(cfg, { harness: "pi", model: "m1", effort: "high" }),
    { harness: "pi", model: "m1", effort: "high" });
  assert.deepEqual(resolveWorkerOverrides(cfg, {}), cfg);
  // A worker on another harness never inherits the phase's Vibe model.
  assert.deepEqual(
    resolveWorkerOverrides(cfg, { harness: "pi" }, "implementor"),
    { harness: "pi", model: null, effort: "medium" });
  assert.deepEqual(
    resolveWorkerOverrides(cfg, { harness: "claude", effort: "high" }, "implementor"),
    { harness: "claude", model: null, effort: "high" });
  // Naming the phase harness explicitly keeps the phase model.
  assert.deepEqual(
    resolveWorkerOverrides(cfg, { harness: "vibe" }, "implementor"),
    { harness: "vibe", model: "glm-5-3-flash", effort: "medium" });
});

test("worker switching to vibe gets the vibe default for its phase", () => {
  const cfg = { harness: "claude", model: "opus", effort: "medium" };
  assert.deepEqual(
    resolveWorkerOverrides(cfg, { harness: "vibe" }, "validator"),
    { harness: "vibe", model: "glm-5-3", effort: "medium" });
});

test("worker record stores the effective values", () => {
  // Mirrors spawnWorker: the overrides are written back onto the record.
  const cfg = { harness: "vibe", model: "glm-5-3", effort: "medium" };
  const worker = { harness: null, model: null, effort: null };
  const effective = resolveWorkerOverrides(cfg, worker);
  worker.harness = effective.harness;
  worker.model = effective.model;
  worker.effort = effective.effort;
  assert.deepEqual(worker, { harness: "vibe", model: "glm-5-3", effort: "medium" });
});

test("spawn body validation accepts valid and absent fields", () => {
  assert.equal(validateWorkerSpawnBody({}), null);
  assert.equal(validateWorkerSpawnBody({ model: "m1", effort: "high" }), null);
  assert.equal(validateWorkerSpawnBody({ model: null, effort: null }), null);
});

test("spawn body validation rejects bad model values (400 cases)", () => {
  assert.equal(validateWorkerSpawnBody({ model: "" }),
    "model must be a non-empty string");
  assert.equal(validateWorkerSpawnBody({ model: "   " }),
    "model must be a non-empty string");
  assert.equal(validateWorkerSpawnBody({ model: 5 }),
    "model must be a non-empty string");
});

test("spawn body validation rejects bad effort values (400 cases)", () => {
  assert.equal(validateWorkerSpawnBody({ effort: "extreme" }),
    "effort must be one of: low, medium, high");
  assert.equal(validateWorkerSpawnBody({ effort: 3 }),
    "effort must be one of: low, medium, high");
});

test("line serialization carries the resolved pipeline", () => {
  const line = {
    id: "line-1", name: "demo", status: "idle", sessionId: "s-1",
    started: true, queue: [{}], workers: new Map([["a", {}], ["b", {}]]),
    pipeline: { planner: { harness: "pi", timeLimit: 60 } },
  };
  const summary = lineSummary(line);
  assert.deepEqual(summary, {
    id: "line-1", name: "demo", status: "idle", humanIntervention: false, queueDepth: 1,
    sessionId: "s-1", started: true, workers: 2,
    pipeline: {
      planner: { harness: "pi", model: null, effort: "medium", timeLimit: 60, maxContext: 150000 },
      implementor: { harness: "vibe", model: "glm-5-3-flash", effort: "medium", timeLimit: 3600,
        maxContext: 150000 },
      validator: { harness: "vibe", model: "glm-5-3", effort: "medium", timeLimit: 3600 },
      integration: { harness: "vibe", model: "glm-5-3", effort: "medium", timeLimit: 3600 },
    },
    pipelineOverrides: { planner: { harness: "pi", timeLimit: 60 } },
  });
  assert.equal(summary.humanIntervention, false);
});

test("line serialization works without a pipeline override", () => {
  const summary = lineSummary({
    id: "line-2", name: "bare", status: "standby", sessionId: null,
    started: false, queue: [], workers: new Map(), pipeline: null,
  });
  assert.equal(summary.pipeline.planner.harness, "vibe");
  assert.equal(summary.workers, 0);
  assert.equal(summary.queueDepth, 0);
});
