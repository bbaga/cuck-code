"use strict";

// Spawn planning: pure helpers that turn resolved pipeline config into
// concrete child process plans. server.js calls these helpers; the unit
// tests exercise them without starting the server or a CLI process.

const path = require("path");
const { createHarness, trustedSystemChannel, writeSystemPromptFile } = require("./harness");
const { resolvePipeline, EFFORT_LEVELS } = require("./pipeline-config");
const { plannerSystemPrompt, plannerUserPrompt } = require("./planner-policy");

// Which pipeline phase a worker run belongs to.
function phaseForWorker(role, kind) {
  if (role === "validator") {
    return kind === "integration" ? "integration" : "validator";
  }
  return "implementor";
}

// Per-worker overrides win over the phase config when set.
function resolveWorkerOverrides(cfg, worker) {
  return {
    harness: worker.harness || cfg.harness,
    model: worker.model || cfg.model,
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

// Decide the next planner launch without touching the line's queue. Returns
// { op: "launch", plan } or { op: "blocked", message }. The request text and
// trusted source metadata are never modified, and the policy never reaches
// the user prompt. A harness without a verified trusted channel (including
// vibe) blocks before any child process starts.
function preparePlannerLaunch(line, cfg, request, autoApprove) {
  if (!trustedSystemChannel(cfg.harness)) {
    return { op: "blocked",
      message: `planner harness "${cfg.harness}" has no trusted system prompt channel; configure a supported planner harness` };
  }
  const systemPrompt = plannerSystemPrompt({
    lineId: line.id, approved: line.planApproved, workdir: line.workdir,
    source: request.source,
  });
  // Router-owned policy directory inside the line workdir; the content-hash
  // file name makes the refresh safe when approval or the source changes.
  const systemPromptFile = writeSystemPromptFile(systemPrompt,
    path.join(line.workdir, "router", "policy"));
  return { op: "launch", plan: planPlannerRun(cfg, {
    prompt: plannerUserPrompt(request.text),
    workdir: line.workdir,
    sessionId: line.sessionId,
    autoApprove,
    systemPrompt,
    systemPromptFile,
  }) };
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
  };
}

module.exports = {
  phaseForWorker,
  resolveWorkerOverrides,
  planPlannerRun,
  preparePlannerLaunch,
  planWorkerRun,
  validateWorkerSpawnBody,
  lineSummary,
};
