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

// A model id belongs to one harness. The code default models are Vibe
// models, so every other harness defaults to null: its CLI then uses its
// own configured default model.
function defaultModelFor(harness, phase) {
  return harness === DEFAULTS.harness ? DEFAULTS.model[phase] : null;
}

// Merge order, most specific wins: code defaults, then environment
// variables, then line.pipeline[phase]. Env values are read at resolve time.
// The env model (e.g. IMPLEMENTOR_MODEL) applies only while the phase runs
// the env/default harness: a line that switches the phase to another
// harness without naming a model gets that harness's default instead of a
// model id meant for a different CLI.
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
    const baseHarness = e[`${prefix}_HARNESS`] || DEFAULTS.harness;
    const harness = phaseCfg.harness || baseHarness;
    const baseModel = harness === baseHarness ? e[`${prefix}_MODEL`] : null;
    result[phase] = {
      harness,
      model: phaseCfg.model || baseModel || defaultModelFor(harness, phase),
      effort: phaseCfg.effort || e[`${prefix}_EFFORT`] || DEFAULTS.effort,
      timeLimit: phaseCfg.timeLimit || envTimeLimit,
    };
  }
  return result;
}

// One probe definition per harness. authCmd must never print credentials.
// pi has no provider-free auth check: its auth state depends on the
// provider, so the base probe only lists the model catalog.
const HARNESS_PROBES = [
  { id: "vibe", versionCmd: ["vibe", "--version"], authCmd: null,
    loginHint: "vibe --setup" },
  { id: "pi", versionCmd: ["pi", "--version"], authCmd: null,
    listModelsCmd: ["pi", "--list-models"],
    loginHint: "pi /login (in the pi TUI)" },
  { id: "codex", versionCmd: ["codex", "--version"],
    authCmd: ["codex", "login", "status"], loginHint: "codex login" },
  { id: "claude", versionCmd: ["claude", "--version"],
    authCmd: ["claude", "auth", "status"], loginHint: "claude login" },
];

const PI_LOGIN_HINT = "pi /login (in the pi TUI)";

// A catalog token (provider or model name) must look like an identifier:
// alphanumeric start, then alphanumerics or . _ @ + -. Prose words pass
// this check, so row structure is validated further below.
function isValidCatalogToken(token) {
  return typeof token === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/.test(token);
}

// A model id in a catalog row must carry version-like structure (a digit
// or a separator). Ordinary error prose ("Failed to load catalog",
// "Command failed") does not, so prose lines never become catalog rows.
function looksLikeModelId(token) {
  return isValidCatalogToken(token) && /[0-9._-]/.test(token.slice(1));
}

// Parse the output of `pi --list-models` into unique provider choices and
// provider-qualified model choices. Tolerates table headers, separator
// rows, variable spacing, and "provider:" section headers with indented
// model lines. Row structure is validated conservatively: a whitespace
// row must have exactly two identifier-like cells, a pipe row takes its
// first two cells, and a model cell must look like a model id. Error
// prose therefore yields no providers and no models. Callers must parse
// only after the command exited 0; a failed command never yields rows.
// Never includes credentials: only provider and model names are read.
function parsePiModelCatalog(stdout) {
  const models = [];
  const seenModels = new Set();
  const addModel = (p, m) => {
    if (!isValidCatalogToken(p) || !looksLikeModelId(m)) return;
    const qualified = `${p}/${m}`;
    if (seenModels.has(qualified)) return;
    seenModels.add(qualified);
    models.push({ value: qualified, label: m });
  };
  let current = null;
  for (const rawLine of String(stdout == null ? "" : stdout).split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    if (/^[\s|:+-=]+$/.test(rawLine)) continue; // table borders/separators
    const indent = rawLine.length - rawLine.trimStart().length;
    const trimmed = rawLine.trim();
    const isPipeRow = rawLine.includes("|");
    const cells = isPipeRow
      ? trimmed.split("|").map((s) => s.trim()).filter(Boolean)
      : trimmed.split(/\s+/);
    if (isPipeRow && cells.length >= 2) {
      const [first, second] = cells;
      if (/^provider$/i.test(first) && /^model$/i.test(second)) {
        current = null; // header row
        continue;
      }
      addModel(first, second);
      current = first;
    } else if (!isPipeRow && cells.length === 2) {
      const [first, second] = cells;
      if (/^provider$/i.test(first) && /^model$/i.test(second)) {
        current = null; // header row
        continue;
      }
      // A whitespace row with more than two cells is prose, not a row.
      addModel(first, second);
      current = first;
    } else if (!isPipeRow && cells.length === 1) {
      const token = cells[0];
      if (token.endsWith(":")) {
        current = token.slice(0, -1);
        // The provider is emitted only when it gains a model below.
      } else if (indent > 0 && current) {
        addModel(current, token);
      }
      // A single unindented token without a colon is not a catalog row.
    }
    // Any other shape (long prose lines, extra columns) is ignored.
  }
  // Providers are derived from accepted model rows: a provider without a
  // model (for example a stray "Error:" line) is never emitted.
  const providers = [];
  const seenProviders = new Set();
  for (const m of models) {
    const p = m.value.slice(0, m.value.indexOf("/"));
    if (!seenProviders.has(p)) {
      seenProviders.add(p);
      providers.push({ value: p, label: p });
    }
  }
  return { providers, models };
}

// Argument array for the per-provider pi auth check. Always spawned as an
// array, never joined into a shell command string.
function piAuthCheckArgs(provider) {
  return ["pi", "auth", "check", "--provider", String(provider), "--json"];
}

// Parse the JSON output of `pi auth check --provider <p> --json`. Only a
// known, non-sensitive hint field is extracted; everything else
// (credentials, tokens, raw output) is discarded.
function parsePiAuthCheck(stdout) {
  const text = stdout == null ? "" : String(stdout).trim();
  if (!text) return { loginHint: null };
  try {
    const parsed = JSON.parse(text);
    const hint = parsed && typeof parsed === "object"
      && typeof parsed.loginHint === "string" ? parsed.loginHint.trim() : "";
    return { loginHint: hint ? hint.slice(0, 200) : null };
  } catch {
    return { loginHint: null };
  }
}

// Comma-separated VIBE_MODELS env value -> trimmed, non-empty model ids.
function parseVibeModelsEnv(value) {
  if (typeof value !== "string") return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

// Stable, deduplicated Vibe model choices from code defaults, the
// configured per-phase model env values, the router's active model env,
// and VIBE_MODELS. Empty values are ignored. Pure in `env`.
function vibeModelChoices(env) {
  const e = env || process.env;
  const choices = [];
  const seen = new Set();
  const add = (value) => {
    const v = typeof value === "string" ? value.trim() : "";
    if (!v || seen.has(v)) return;
    seen.add(v);
    choices.push({ value: v, label: v });
  };
  for (const phase of PHASES) add(DEFAULTS.model[phase]);
  for (const phase of PHASES) add(e[`${PHASE_ENV_PREFIX[phase]}_MODEL`]);
  add(e.VIBE_ACTIVE_MODEL);
  for (const m of parseVibeModelsEnv(e.VIBE_MODELS)) add(m);
  return choices;
}

// The Claude Code CLI resolves these aliases to the latest model of each
// family, so they stay valid across model releases.
const CLAUDE_MODEL_ALIASES = ["opus", "sonnet", "haiku"];

// Stable, deduplicated Claude model choices: the CLI aliases, then the
// full model ids from CLAUDE_MODELS (comma-separated). Pure in `env`.
function claudeModelChoices(env) {
  const e = env || process.env;
  const seen = new Set();
  const choices = [];
  for (const v of [...CLAUDE_MODEL_ALIASES, ...parseVibeModelsEnv(e.CLAUDE_MODELS)]) {
    if (seen.has(v)) continue;
    seen.add(v);
    choices.push({ value: v, label: v });
  }
  return choices;
}

// run(cmdArray) returns a Promise of { code, stdout }, or null when the
// command cannot start or times out. Returns one result per harness:
// { id, installed, auth, loginHint, version } plus, for vibe and claude,
// `models` and, for pi, `authModes` and provider-qualified `models`.
async function probeHarnesses(run, env) {
  return Promise.all(HARNESS_PROBES.map(async (probe) => {
    const versionRes = await run(probe.versionCmd);
    let auth = "unknown";
    if (probe.authCmd) {
      const authRes = await run(probe.authCmd);
      if (authRes) auth = authRes.code === 0 ? "ok" : "missing";
    }
    const result = {
      id: probe.id,
      installed: versionRes != null,
      auth,
      loginHint: probe.loginHint,
      version: versionRes && versionRes.stdout != null
        ? String(versionRes.stdout).split("\n")[0].trim() || null
        : null,
    };
    if (probe.id === "vibe") {
      result.models = vibeModelChoices(env);
    }
    if (probe.id === "claude") {
      result.models = claudeModelChoices(env);
    }
    if (probe.id === "pi" && probe.listModelsCmd) {
      const catalogRes = await run(probe.listModelsCmd);
      // A failed command yields no providers and no models, whatever it
      // printed: error prose must never become a catalog row.
      const catalog = catalogRes && catalogRes.code === 0
        ? parsePiModelCatalog(catalogRes.stdout)
        : { providers: [], models: [] };
      result.authModes = catalog.providers;
      result.models = catalog.models;
    }
    return result;
  }));
}

// Resolve GET /api/harnesses/pi?provider=<provider> against a probed pi
// entry. Returns { error } for a missing or unknown provider (HTTP 400)
// or { detail } with the fixed contract shape. Runs the auth check with
// an argument array through the injected run() and never returns
// credentials or raw command output.
async function piProviderDetail(provider, piProbeResult, run) {
  const requested = typeof provider === "string" ? provider.trim() : "";
  if (!requested) {
    return { error: "provider query parameter is required" };
  }
  const authModes = piProbeResult && Array.isArray(piProbeResult.authModes)
    ? piProbeResult.authModes : [];
  if (!authModes.some((m) => m && m.value === requested)) {
    const known = authModes.map((m) => m && m.value).filter(Boolean).join(", ");
    return {
      error: known
        ? `unknown provider '${requested}' (known providers: ${known})`
        : `unknown provider '${requested}': pi is not installed or reported no providers`,
    };
  }
  const models = (piProbeResult && Array.isArray(piProbeResult.models)
    ? piProbeResult.models : [])
    .filter((m) => m && typeof m.value === "string"
      && m.value.startsWith(`${requested}/`));
  let auth = "unknown";
  let loginHint = (piProbeResult && piProbeResult.loginHint) || PI_LOGIN_HINT;
  if (piProbeResult && piProbeResult.installed) {
    const authRes = await run(piAuthCheckArgs(requested));
    if (authRes) {
      auth = authRes.code === 0 ? "ok" : "missing";
      const parsed = parsePiAuthCheck(authRes.stdout);
      if (parsed.loginHint) loginHint = parsed.loginHint;
    }
  }
  return {
    detail: { id: "pi", authMode: requested, auth, loginHint, models },
  };
}

// Return the probe result entry whose id matches, or null when no entry
// matches. Pure helper for callers that probe a single harness.
function probeResultFor(results, id) {
  if (!Array.isArray(results)) return null;
  return results.find((r) => r && r.id === id) || null;
}

module.exports = {
  PHASES,
  HARNESS_IDS,
  EFFORT_LEVELS,
  validatePipelineConfig,
  defaultModelFor,
  resolvePipeline,
  HARNESS_PROBES,
  probeHarnesses,
  probeResultFor,
  parsePiModelCatalog,
  piAuthCheckArgs,
  parsePiAuthCheck,
  parseVibeModelsEnv,
  vibeModelChoices,
  claudeModelChoices,
  piProviderDetail,
};
