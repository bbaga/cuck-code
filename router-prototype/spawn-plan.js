"use strict";

// Spawn planning: pure helpers that turn resolved pipeline config into
// concrete child process plans. server.js calls these helpers; the unit
// tests exercise them without starting the server or a CLI process.

const { createHarness, trustedSystemChannel, writeSystemPromptFile } = require("./harness");
const { resolvePipeline, resolveNodeSettings, defaultModelFor, EFFORT_LEVELS } = require("./pipeline-config");

// Which pipeline phase a worker run belongs to.
function phaseForWorker(role, kind) {
  if (role === "validator") {
    return kind === "integration" ? "integration" : "validator";
  }
  return "implementor";
}

// Run settings of the planner: the start node of the line graph. A line
// without a graph uses the old per-phase view.
function plannerSettings(line) {
  if (line.graph && line.graph.start) return resolveNodeSettings(line, line.graph.start);
  return resolvePipeline(line).planner;
}

// Run settings of a worker: its node. A worker without a node yet uses the
// old per-phase view.
function workerSettings(line, worker) {
  if (worker.node && line.graph) return resolveNodeSettings(line, worker.node);
  return resolvePipeline(line)[phaseForWorker(worker.role, worker.kind)];
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

// Trusted system prompt delivery (task B5).
//
// A node prompt has a role part (router rules, role text) and a task part.
// A harness with a trusted system prompt channel (claude, pi, codex) gets the
// role part through that channel and only the task part as the user turn. A
// harness without one (vibe) gets the full prompt in the user turn, as before.

// Role texts at least this long go through a file when the harness has a file
// channel; the body then stays off the command line.
const SYSTEM_PROMPT_FILE_MIN_CHARS = 1000;

// True when this harness gets the role part through its system channel.
function usesSystemChannel(harnessId, rolePrompt) {
  return typeof rolePrompt === "string" && rolePrompt !== "" && trustedSystemChannel(harnessId) !== null;
}

// The system prompt options of one run: {} (nothing to send), {systemPrompt}
// (inline text) or {systemPromptFile}. The file lives in dir, a router-owned
// directory that writeSystemPromptFile creates with owner-only permissions
// (0700 directory, 0600 files). Codex has no file channel and always gets
// inline text. Pass dir = null to force inline text.
function systemPromptOptions(harnessId, rolePrompt, dir) {
  if (!usesSystemChannel(harnessId, rolePrompt)) return {};
  const channel = trustedSystemChannel(harnessId);
  if (channel.file && dir && rolePrompt.length >= SYSTEM_PROMPT_FILE_MIN_CHARS) {
    return { systemPromptFile: writeSystemPromptFile(rolePrompt, dir) };
  }
  return { systemPrompt: rolePrompt };
}

// The brief text for the user turn of a first or reseeded run. stored holds
// the full brief (prompt) and the split parts (rolePrompt, taskPrompt). A
// legacy record without the split, or a harness without a channel, uses the
// full brief.
function briefForHarness(harnessId, stored) {
  if (usesSystemChannel(harnessId, stored.rolePrompt) && typeof stored.taskPrompt === "string") {
    return stored.taskPrompt;
  }
  return stored.prompt;
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

// Build the implementor branch name. Ticketed branches use the exact ticket
// ID as their prefix; unticketed branches keep the line-ID prefix.
function implementorBranchName(lineId, workerName, trackerTicket) {
  const prefix = trackerTicket ? trackerTicket : lineId.slice(0, 8);
  return `${prefix}/${workerName}`;
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
    humanIntervention: line.humanIntervention === true,
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
  usesSystemChannel,
  systemPromptOptions,
  briefForHarness,
  SYSTEM_PROMPT_FILE_MIN_CHARS,
  phaseForWorker,
  plannerSettings,
  workerSettings,
  resolveWorkerOverrides,
  planPlannerRun,
  planWorkerRun,
  validateWorkerSpawnBody,
  implementorBranchName,
  lineSummary,
};
