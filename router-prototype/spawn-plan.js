"use strict";

// Spawn planning: pure helpers that turn resolved pipeline config into
// concrete child process plans. server.js calls these helpers; the unit
// tests exercise them without starting the server or a CLI process.

const { createHarness } = require("./harness");
const { resolvePipeline, defaultModelFor, EFFORT_LEVELS } = require("./pipeline-config");

// Which pipeline phase a worker run belongs to.
function phaseForWorker(role, kind) {
  if (role === "validator") {
    return kind === "integration" ? "integration" : "validator";
  }
  return "implementor";
}

// Per-worker overrides win over the phase config when set. A worker that
// switches to another harness without naming a model gets that harness's
// default model, never the phase model meant for a different CLI.
function resolveWorkerOverrides(cfg, worker, phase) {
  const harness = worker.harness || cfg.harness;
  const fallbackModel = harness === cfg.harness ? cfg.model : defaultModelFor(harness, phase);
  return {
    harness,
    model: worker.model || fallbackModel,
    effort: worker.effort || cfg.effort,
  };
}

function planRun(cfg, opts) {
  const adapter = createHarness(cfg.harness);
  const run = adapter.buildRun({
    phase: opts.phase,
    prompt: opts.prompt,
    workdir: opts.workdir,
    sessionId: opts.sessionId || null,
    model: cfg.model,
    effort: cfg.effort,
    timeLimitSec: cfg.timeLimit,
    autoApprove: opts.autoApprove,
    // Trusted system prompt (router-owned policy) and its optional
    // router-owned file. Undefined for every existing caller, so plans for
    // them stay byte-for-byte unchanged. buildRun fails closed when the
    // harness has no verified trusted channel.
    systemPrompt: opts.systemPrompt,
    systemPromptFile: opts.systemPromptFile,
  });
  return { ...run, adapter };
}

// Build the child process plan for one planner run. cfg is the resolved
// planner config (resolvePipeline(line).planner).
function planPlannerRun(cfg, opts) {
  return planRun(cfg, { ...opts, phase: "planner" });
}

// Build the child process plan for one worker run. cfg is the resolved
// phase config with the per-worker overrides already applied.
function planWorkerRun(cfg, opts) {
  return planRun(cfg, opts);
}

// Validate the optional worker spawn body fields beyond "harness" (which
// the handler validates and gates separately). Returns an error string
// or null.
function validateWorkerSpawnBody(body) {
  if (body.model !== undefined && body.model !== null
    && (typeof body.model !== "string" || !body.model.trim())) {
    return "model must be a non-empty string";
  }
  if (body.effort !== undefined && body.effort !== null
    && !EFFORT_LEVELS.includes(body.effort)) {
    return `effort must be one of: ${EFFORT_LEVELS.join(", ")}`;
  }
  return null;
}

// Serialize a line for GET /api/lines: the summary fields plus the
// resolved pipeline configuration.
function lineSummary(line) {
  return {
    id: line.id,
    name: line.name,
    status: line.status,
    queueDepth: line.queue ? line.queue.length : 0,
    sessionId: line.sessionId,
    started: line.started,
    workers: line.workers ? line.workers.size : 0,
    pipeline: resolvePipeline(line),
    // The line's own settings, without defaults: what the pipeline editor
    // shows and saves.
    pipelineOverrides: line.pipeline || null,
  };
}

module.exports = {
  phaseForWorker,
  resolveWorkerOverrides,
  planPlannerRun,
  planWorkerRun,
  validateWorkerSpawnBody,
  lineSummary,
};
