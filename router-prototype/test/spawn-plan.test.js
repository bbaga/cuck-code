"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fallbackPhaseSettings } = require("../pipeline-config");
const resolvePipeline = (line, env) => new Proxy({}, { get: (_t, phase) => fallbackPhaseSettings(line, phase, env) });
const { planPlannerRun, planWorkerRun, implementorBranchName } = require("../spawn-plan");

// Regression guarantee: with the default config (no env overrides, no
// line.pipeline) the built vibe argv, env, and cwd for planners and
// workers must equal the argv arrays of the pre-adapter code, listed
// literally here.

const PLANNER_ARGS_TAIL = [
  "--workdir", "/tmp/line", "--trust", "--agent", "accept-edits",
  "--output", "streaming", "--time-limit", "1800",
];
const WORKER_ARGS_TAIL = [
  "--workdir", "/tmp/wt", "--trust", "--agent", "accept-edits",
  "--output", "streaming", "--time-limit", "3600",
];

test("implementor branches use the tracker ticket when present", () => {
  assert.equal(implementorBranchName("12345678-abcd", "worker-one", "TICKET-123"), "TICKET-123/worker-one");
});

test("implementor branches keep the line-ID prefix without a ticket", () => {
  assert.equal(implementorBranchName("12345678-abcd", "worker-one", null), "12345678/worker-one");
  assert.equal(implementorBranchName("12345678-abcd", "worker-one", ""), "12345678/worker-one");
});

function defaultPlannerCfg() {
  return resolvePipeline({}, {}).planner;
}

function defaultWorkerCfg(phase) {
  return resolvePipeline({}, {})[phase];
}

test("planner fresh run with default config matches the old argv exactly", () => {
  const plan = planPlannerRun(defaultPlannerCfg(), {
    prompt: "plan the work", workdir: "/tmp/line", sessionId: null,
    autoApprove: true,
  });
  assert.equal(plan.cmd, "vibe");
  assert.deepEqual(plan.args, [
    ...PLANNER_ARGS_TAIL, "--auto-approve", "-p", "plan the work",
  ]);
  assert.deepEqual(plan.env, {});
  assert.equal(plan.cwd, undefined);
});

test("planner resumed run with default config matches the old argv exactly", () => {
  const plan = planPlannerRun(defaultPlannerCfg(), {
    prompt: "continue", workdir: "/tmp/line", sessionId: "sess-1",
    autoApprove: true,
  });
  assert.deepEqual(plan.args, [
    "--resume", "sess-1", ...PLANNER_ARGS_TAIL, "--auto-approve", "-p", "continue",
  ]);
});

test("worker fresh run with default config matches the old argv and env exactly", () => {
  const plan = planWorkerRun(defaultWorkerCfg("implementor"), {
    phase: "implementor", prompt: "build it", workdir: "/tmp/wt",
    sessionId: null, autoApprove: true,
  });
  assert.equal(plan.cmd, "vibe");
  assert.deepEqual(plan.args, [
    ...WORKER_ARGS_TAIL, "--auto-approve", "-p", "build it",
  ]);
  assert.deepEqual(plan.env, { VIBE_ACTIVE_MODEL: "glm-5-3-flash" });
  assert.equal(plan.cwd, undefined);
});

test("worker resumed run with default config matches the old argv exactly", () => {
  const plan = planWorkerRun(defaultWorkerCfg("implementor"), {
    phase: "implementor", prompt: "finish it", workdir: "/tmp/wt",
    sessionId: "sess-9", autoApprove: true,
  });
  assert.deepEqual(plan.args, [
    "--resume", "sess-9", ...WORKER_ARGS_TAIL, "--auto-approve", "-p", "finish it",
  ]);
  assert.deepEqual(plan.env, { VIBE_ACTIVE_MODEL: "glm-5-3-flash" });
});

test("planner and worker without AUTO_APPROVE omit the flag", () => {
  const planner = planPlannerRun(defaultPlannerCfg(), {
    prompt: "p", workdir: "/tmp/line", sessionId: null, autoApprove: false,
  });
  assert.deepEqual(planner.args, [...PLANNER_ARGS_TAIL, "-p", "p"]);
  const worker = planWorkerRun(defaultWorkerCfg("validator"), {
    phase: "validator", prompt: "p", workdir: "/tmp/wt",
    sessionId: null, autoApprove: false,
  });
  assert.deepEqual(worker.args, [...WORKER_ARGS_TAIL, "-p", "p"]);
  assert.deepEqual(worker.env, { VIBE_ACTIVE_MODEL: "glm-5-3" });
});

test("planner adapter has the native time limit, worker adapters report theirs", () => {
  const planner = planPlannerRun(defaultPlannerCfg(), {
    prompt: "p", workdir: "/tmp/line", sessionId: null, autoApprove: true,
  });
  assert.equal(planner.adapter.supportsNativeTimeLimit, true);
  const pi = planWorkerRun({ ...defaultWorkerCfg("implementor"), harness: "pi" }, {
    phase: "implementor", prompt: "p", workdir: "/tmp/wt",
    sessionId: null, autoApprove: true,
  });
  assert.equal(pi.adapter.supportsNativeTimeLimit, false);
  assert.equal(pi.cwd, "/tmp/wt");
});
