"use strict";

// Pipeline configuration layer: per-phase harness/model/effort/timeLimit
// resolution and harness availability probes. Pure logic, no I/O except
// through the injected run() function in probeHarnesses().

const PHASES = ["planner", "implementor", "validator", "integration"];
const HARNESS_IDS = ["vibe", "pi", "codex", "claude"];
const EFFORT_LEVELS = ["low", "medium", "high"];

const PIPELINE_FIELDS = ["harness", "model", "effort", "timeLimit"];

// Env var prefix per phase, e.g. PLANNER_HARNESS, IMPLEMENTOR_MODEL.
const PHASE_ENV_PREFIX = {
  planner: "PLANNER",
  implementor: "IMPLEMENTOR",
  validator: "VALIDATOR",
  integration: "INTEGRATION",
};

// Code defaults, before env and line.pipeline overrides.
const DEFAULTS = {
  harness: "vibe",
  model: {
    planner: null, // no model override today
    implementor: "glm-5-3-flash",
    validator: "glm-5-3",
    integration: "glm-5-3",
  },
  effort: "medium",
};

function validatePipelineConfig(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return "pipeline must be an object";
  }
  for (const key of Object.keys(raw)) {
    if (!PHASES.includes(key)) {
      return `unknown pipeline phase: '${key}' (allowed: ${PHASES.join(", ")})`;
    }
    const phase = raw[key];
    if (phase === null || typeof phase !== "object" || Array.isArray(phase)) {
      return `pipeline.${key} must be an object`;
    }
    for (const field of Object.keys(phase)) {
      if (!PIPELINE_FIELDS.includes(field)) {
        return `unknown field '${field}' in pipeline.${key} (allowed: ${PIPELINE_FIELDS.join(", ")})`;
      }
      const v = phase[field];
      if (field === "harness" && !HARNESS_IDS.includes(v)) {
        return `pipeline.${key}.harness must be one of: ${HARNESS_IDS.join(", ")}`;
      }
      if (field === "model" && (typeof v !== "string" || !v.trim())) {
        return `pipeline.${key}.model must be a non-empty string`;
      }
      if (field === "effort" && !EFFORT_LEVELS.includes(v)) {
        return `pipeline.${key}.effort must be one of: ${EFFORT_LEVELS.join(", ")}`;
      }
      if (field === "timeLimit"
        && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) {
        return `pipeline.${key}.timeLimit must be a positive number`;
      }
    }
  }
  return null;
}

// Merge order, most specific wins: code defaults, then environment
// variables, then line.pipeline[phase]. Env values are read at resolve time.
function resolvePipeline(line, env) {
  const e = env || process.env;
  const pipeline = line && line.pipeline ? line.pipeline : {};
  const result = {};
  for (const phase of PHASES) {
    const prefix = PHASE_ENV_PREFIX[phase];
    const phaseCfg = pipeline[phase] || {};
    const envTimeLimit = phase === "planner"
      ? Number(e.PLANNER_TIME_LIMIT || 1800)
      : Number(e.WORKER_TIME_LIMIT || 3600);
    result[phase] = {
      harness: phaseCfg.harness || e[`${prefix}_HARNESS`] || DEFAULTS.harness,
      model: phaseCfg.model || e[`${prefix}_MODEL`] || DEFAULTS.model[phase],
      effort: phaseCfg.effort || e[`${prefix}_EFFORT`] || DEFAULTS.effort,
      timeLimit: phaseCfg.timeLimit || envTimeLimit,
    };
  }
  return result;
}

// One probe definition per harness. authCmd must never print credentials.
const HARNESS_PROBES = [
  { id: "vibe", versionCmd: ["vibe", "--version"], authCmd: null,
    loginHint: "vibe --setup" },
  { id: "pi", versionCmd: ["pi", "--version"], authCmd: ["pi", "auth", "check"],
    loginHint: "pi /login (in the pi TUI)" },
  { id: "codex", versionCmd: ["codex", "--version"],
    authCmd: ["codex", "login", "status"], loginHint: "codex login" },
  { id: "claude", versionCmd: ["claude", "--version"],
    authCmd: ["claude", "auth", "status"], loginHint: "claude login" },
];

// run(cmdArray) returns a Promise of { code, stdout }, or null when the
// command cannot start or times out. Returns one result per harness:
// { id, installed, auth, loginHint, version }.
async function probeHarnesses(run) {
  return Promise.all(HARNESS_PROBES.map(async (probe) => {
    const versionRes = await run(probe.versionCmd);
    let auth = "unknown";
    if (probe.authCmd) {
      const authRes = await run(probe.authCmd);
      if (authRes) auth = authRes.code === 0 ? "ok" : "missing";
    }
    return {
      id: probe.id,
      installed: versionRes != null,
      auth,
      loginHint: probe.loginHint,
      version: versionRes && versionRes.stdout != null
        ? String(versionRes.stdout).split("\n")[0].trim() || null
        : null,
    };
  }));
}

module.exports = {
  PHASES,
  HARNESS_IDS,
  EFFORT_LEVELS,
  validatePipelineConfig,
  resolvePipeline,
  HARNESS_PROBES,
  probeHarnesses,
};
