"use strict";

// Pipeline configuration layer: per-phase harness/model/effort/timeLimit
// (and maxContext for resumed sessions) resolution and harness availability probes. Pure logic, no I/O except
// through the injected run() function in probeHarnesses().

const { parseAutoThreshold } = require("./compaction");

const PHASES = ["planner", "implementor", "validator", "integration"];
const HARNESS_IDS = ["vibe", "pi", "codex", "claude"];
const EFFORT_LEVELS = ["low", "medium", "high"];

const PIPELINE_FIELDS = ["harness", "model", "effort", "timeLimit", "maxContext"];

// Phases whose sessions are resumed across runs and can be compacted.
// maxContext (tokens) is the context size at which the router compacts the
// session; validators start fresh on every run and take no maxContext.
const CONTEXT_PHASES = ["planner", "implementor"];

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

// Check the run settings of one phase or node. Returns an error string or
// null. label prefixes every message (for example "pipeline.planner").
// opts.strict: report a key outside PIPELINE_FIELDS (default: skip it, the
// caller checks its own keys). opts.maxContext: false means maxContext is
// not supported here (default: true).
function validateNodeSettings(label, settings, opts) {
  const strict = !!(opts && opts.strict);
  const allowContext = !opts || opts.maxContext !== false;
  for (const field of Object.keys(settings)) {
    if (!PIPELINE_FIELDS.includes(field)) {
      if (strict) {
        return `unknown field '${field}' in ${label} (allowed: ${PIPELINE_FIELDS.join(", ")})`;
      }
      continue;
    }
    const v = settings[field];
    if (field === "harness" && !HARNESS_IDS.includes(v)) {
      return `${label}.harness must be one of: ${HARNESS_IDS.join(", ")}`;
    }
    if (field === "model" && (typeof v !== "string" || !v.trim())) {
      return `${label}.model must be a non-empty string`;
    }
    if (field === "effort" && !EFFORT_LEVELS.includes(v)) {
      return `${label}.effort must be one of: ${EFFORT_LEVELS.join(", ")}`;
    }
    if (field === "timeLimit"
      && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) {
      return `${label}.timeLimit must be a positive number`;
    }
    if (field === "maxContext") {
      if (!allowContext) {
        return `${label}.maxContext is not supported (only: ${CONTEXT_PHASES.join(", ")})`;
      }
      if (!Number.isInteger(v) || v < 1000) {
        return `${label}.maxContext must be an integer number of tokens, at least 1000`;
      }
    }
  }
  return null;
}

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
    const message = validateNodeSettings(`pipeline.${key}`, phase, {
      strict: true,
      maxContext: CONTEXT_PHASES.includes(key),
    });
    if (message) return message;
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
function mergePhase(phase, e, cfg, withContext) {
  const prefix = PHASE_ENV_PREFIX[phase];
  const envTimeLimit = phase === "planner"
    ? Number(e.PLANNER_TIME_LIMIT || 1800)
    : Number(e.WORKER_TIME_LIMIT || 3600);
  const baseHarness = e[`${prefix}_HARNESS`] || DEFAULTS.harness;
  const harness = cfg.harness || baseHarness;
  const baseModel = harness === baseHarness ? e[`${prefix}_MODEL`] : null;
  const result = {
    harness,
    model: cfg.model || baseModel || defaultModelFor(harness, phase),
    effort: cfg.effort || e[`${prefix}_EFFORT`] || DEFAULTS.effort,
    timeLimit: cfg.timeLimit || envTimeLimit,
  };
  if (withContext) result.maxContext = cfg.maxContext || parseAutoThreshold(e.COMPACT_AUTO_TOKENS);
  return result;
}

// line-graph loads the pipeline resolver, which needs this module: load it late.
function phaseOfType(graph, typeName) {
  return require("./line-graph").phaseOfType(graph, typeName);
}

function graphType(graph, nodeId) {
  const node = graph && graph.nodes && Object.prototype.hasOwnProperty.call(graph.nodes, nodeId)
    ? graph.nodes[nodeId] : null;
  return node ? node : null;
}

// Does the node type keep its session across runs (session: resume)?
function nodeResumes(graph, nodeId) {
  const node = graphType(graph, nodeId);
  const type = node && graph.types && graph.types[node.type];
  return !!type && type.session === "resume";
}

// Check settings for one node of a resolved graph: maxContext is allowed only
// on a node whose type has session: resume. Returns an error string or null.
function validateNodeSettingsForNode(graph, nodeId, settings) {
  if (!graphType(graph, nodeId)) return `no such node '${nodeId}'`;
  return validateNodeSettings(`nodeSettings.${nodeId}`, settings || {}, {
    strict: true,
    maxContext: nodeResumes(graph, nodeId),
  });
}

// Run settings of one node, most specific wins: code defaults for the phase
// of the node type, env vars of that phase, the pipeline file node settings,
// the legacy line.pipeline[phase] override, then line.nodeSettings[nodeId].
// The env model applies only to the env harness (see resolvePipeline).
// maxContext is set only for a node type with session: resume.
function resolveNodeSettings(line, nodeId, env) {
  const e = env || process.env;
  const graph = line && line.graph;
  const node = graphType(graph, nodeId);
  if (!node) throw new Error(`no such node '${nodeId}'`);
  const phase = phaseOfType(graph, node.type);
  if (!phase) throw new Error(`node '${nodeId}' has a type without a phase`);
  // line.nodeSettings is the stored truth. The phase overrides apply only to a
  // line that has no node settings (line.pipeline is then the only record).
  const legacy = !line.nodeSettings && line.pipeline && line.pipeline[phase] ? line.pipeline[phase] : {};
  const own = line.nodeSettings && line.nodeSettings[nodeId] ? line.nodeSettings[nodeId] : {};
  const merged = { ...(node.settings || {}), ...legacy, ...own };
  const resumes = nodeResumes(graph, nodeId);
  const result = mergePhase(phase, e, merged, resumes);
  if (!resumes) delete result.maxContext;
  return result;
}

// The old per-phase view. With a graph, each phase uses the first node of
// that phase in graph order; without one (or without such a node) the old
// line.pipeline overrides apply as before.
function resolvePipeline(line, env) {
  const e = env || process.env;
  const pipeline = line && line.pipeline ? line.pipeline : {};
  const graph = line && line.graph;
  const result = {};
  for (const phase of PHASES) {
    const nodeId = graph && graph.nodes
      ? Object.keys(graph.nodes).find((id) => phaseOfType(graph, graph.nodes[id].type) === phase)
      : null;
    if (nodeId && (!CONTEXT_PHASES.includes(phase) || nodeResumes(graph, nodeId))) {
      result[phase] = resolveNodeSettings(line, nodeId, e);
      if (CONTEXT_PHASES.includes(phase) && result[phase].maxContext === undefined) {
        result[phase].maxContext = parseAutoThreshold(e.COMPACT_AUTO_TOKENS);
      }
    } else {
      result[phase] = mergePhase(phase, e, pipeline[phase] || {}, CONTEXT_PHASES.includes(phase));
    }
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
// A slash is allowed: real catalog rows can carry a provider-qualified id
// in the model column (for example "google/gemma-4-e4b").
function looksLikeModelId(token) {
  return typeof token === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._@+/:.-]*$/.test(token)
    && /[0-9._-]/.test(token.slice(1));
}

// Parse the output of `pi --list-models` into unique provider choices and
// provider-qualified model choices. Tolerates table headers, separator
// rows, variable spacing, and "provider:" section headers with indented
// model lines. Row structure is validated conservatively: a whitespace
// row takes its first two identifier-like cells, a wider row is data only
// when a "provider model ..." header announced that exact column count
// (real catalogs print metadata columns next to provider and model), a
// pipe row takes its first two cells, and a model cell must look like a
// model id. Error prose therefore yields no providers and no models.
// Callers must parse only after the command exited 0; a failed command
// never yields rows. Never includes credentials: only provider and
// model names are read.
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
  // Column count announced by a "provider model ..." header row. Wider
  // whitespace rows are catalog data only while they match this count;
  // without a header, a row with more than two cells is prose, not data.
  let headerColumns = null;
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
    } else if (!isPipeRow && cells.length >= 2) {
      const [first, second] = cells;
      if (/^provider$/i.test(first) && /^model$/i.test(second)) {
        headerColumns = cells.length; // header row, any width
        current = null;
        continue;
      }
      // Two cells are always a candidate row; a wider row is data only
      // when a header announced that exact column count. Real catalogs
      // print metadata columns (context, max-out, ...) next to the
      // provider and model; prose lines never match the header width.
      if (cells.length === 2
        || (headerColumns !== null && cells.length === headerColumns)) {
        addModel(first, second);
        current = first;
      }
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

function claudeText(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 200);
}

function claudePickerOptions(settings) {
  const options = settings && settings.modelPicker && settings.modelPicker.options;
  if (!Array.isArray(options)) return [];
  return options.map((row) => {
    if (!row || typeof row !== "object") return null;
    const value = claudeText(row.value || row.model);
    if (!value) return null;
    return { value, label: claudeText(row.label) || value };
  }).filter(Boolean);
}

function claudeGatewayModels(cache) {
  if (!cache || !Array.isArray(cache.models)) return [];
  return cache.models.map((row) => {
    if (!row || typeof row !== "object") return null;
    const value = claudeText(row.id);
    if (!value) return null;
    return { value, label: claudeText(row.display_name || row.name || row.short_name) || value };
  }).filter(Boolean);
}

function claudeModelChoices(config) {
  const c = config && typeof config === "object" ? config : {};
  const rows = CLAUDE_MODEL_ALIASES.map((value) => ({ value, label: value }));
  const picker = claudePickerOptions(c.settings);
  const local = claudePickerOptions(c.localSettings);
  const gateway = claudeGatewayModels(c.gatewayCache);
  const pickerLabels = new Set([...picker, ...local].map((row) => row.label));
  const seen = new Set();
  const choices = [];
  for (const row of [...rows, ...picker, ...local, ...gateway]) {
    if (gateway.includes(row) && pickerLabels.has(row.label)) continue;
    if (seen.has(row.value)) continue;
    seen.add(row.value);
    choices.push({ value: row.value, label: row.label });
    if (choices.length === 100) break;
  }
  return choices;
}

// run(cmdArray) returns a Promise of { code, stdout }, or null when the
// command cannot start or times out. Returns one result per harness:
// { id, installed, auth, loginHint, version } plus, for vibe and claude,
// `models` and, for pi, `authModes` and provider-qualified `models`.
async function probeHarnesses(run, env, readClaudeConfig) {
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
      let config;
      try { config = typeof readClaudeConfig === "function" ? await readClaudeConfig() : null; }
      catch { config = null; }
      result.models = claudeModelChoices(config);
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
  CONTEXT_PHASES,
  HARNESS_IDS,
  EFFORT_LEVELS,
  validatePipelineConfig,
  validateNodeSettings,
  defaultModelFor,
  resolvePipeline,
  resolveNodeSettings,
  validateNodeSettingsForNode,
  HARNESS_PROBES,
  probeHarnesses,
  probeResultFor,
  parsePiModelCatalog,
  piAuthCheckArgs,
  parsePiAuthCheck,
  parseVibeModelsEnv,
  vibeModelChoices,
  claudeText,
  claudePickerOptions,
  claudeGatewayModels,
  claudeModelChoices,
  piProviderDetail,
};
