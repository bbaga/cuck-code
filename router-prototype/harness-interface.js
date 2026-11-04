"use strict";

// Contract of the harness plugin interface v1, and the validator that checks
// a plugin object against it. The router calls validateHarnessPlugin() once
// per plugin, before it registers the plugin. Pure code: no I/O.

const API_VERSION = 1;
const BUILTIN_HARNESS_IDS = ["vibe", "pi", "codex", "claude"];
const SYSTEM_PROMPT_MODES = ["file", "text", "none"];
const ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

const CAPABILITY_KEYS = ["resume", "systemPrompt", "nativeTimeLimit", "providers"];
const REQUIRED_METHODS = ["probe", "listModels", "startSession", "resumeSession"];
const PROVIDER_METHODS = ["listProviders", "checkAuth"];
const OPTIONAL_METHODS = ["readTranscript"];
const ALLOWED_KEYS = [
  "apiVersion", "id", "displayName", "capabilities",
  ...REQUIRED_METHODS, ...PROVIDER_METHODS, ...OPTIONAL_METHODS,
];

/**
 * @typedef {{ value: string, label: string }} Choice
 *
 * @typedef {{ installed: boolean, version: string|null,
 *   auth: "ok"|"missing"|"unknown", loginHint: string }} ProbeResult
 *
 * @typedef {{ sdk: object, env: object, pluginDir: string,
 *   log: (level: string, event: string, data?: object) => void }} HarnessContext
 *
 * @typedef {{ phase: string, prompt: string, workdir: string,
 *   sessionId: string|null, model: string|null,
 *   effort: "low"|"medium"|"high", timeLimitSec: number,
 *   autoApprove: boolean, systemPrompt: string|null,
 *   systemPromptFile: string|null }} HarnessRequest
 *
 * @typedef {{ type: "message", role: string, text: string,
 *   sessionId: string|null, at: string }} Entry
 *
 * @typedef {{ entry: (e: { role: string, text: string }) => void,
 *   session: (id: string) => void,
 *   contextTokens: (n: number) => void,
 *   error: (text: string) => void }} HarnessSink
 *
 * @typedef {{ outcome: "ok"|"fail"|"timeout", exitCode: number|null,
 *   signal: string|null, command: string, spawnError: Error|null,
 *   stderr: string|null }} RunResult
 *
 * @typedef {{ stop: (signal?: string) => boolean,
 *   done: Promise<RunResult> }} HarnessRun
 *
 * @typedef {{ resume: boolean, systemPrompt: "file"|"text"|"none",
 *   nativeTimeLimit: boolean, providers: boolean }} Capabilities
 *
 * @typedef {object} HarnessPlugin
 * @property {1} apiVersion
 * @property {string} id
 * @property {string} [displayName]
 * @property {Capabilities} capabilities
 * @property {(ctx: HarnessContext) => Promise<ProbeResult>} probe
 * @property {(ctx: HarnessContext, query: { provider?: string }) => Promise<Choice[]>} listModels
 * @property {(ctx: HarnessContext, request: HarnessRequest, sink: HarnessSink) => HarnessRun} startSession
 * @property {(ctx: HarnessContext, request: HarnessRequest, sink: HarnessSink) => HarnessRun} resumeSession
 * @property {(ctx: HarnessContext) => Promise<Choice[]>} [listProviders]
 * @property {(ctx: HarnessContext, query: { provider: string }) => Promise<{ auth: string, loginHint: string }>} [checkAuth]
 * @property {(ctx: HarnessContext, q: { sessionId: string, workdir: string }) => Promise<Entry[]|null>} [readTranscript]
 */

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

// Plugin code is untrusted: a getter or a Proxy trap can throw. These helpers
// turn such a throw into an error message, so the validator never throws.
function safeGet(obj, key, label, errors) {
  try {
    return obj[key];
  } catch (err) {
    errors.push(`${label}: cannot read property (${errorMessage(err)})`);
    return undefined;
  }
}

function safeHas(obj, key, label, errors) {
  try {
    return key in obj;
  } catch (err) {
    errors.push(`${label}: cannot read property (${errorMessage(err)})`);
    return false;
  }
}

function safeKeys(obj, label, errors) {
  try {
    return Object.keys(obj);
  } catch (err) {
    errors.push(`${label}: cannot list keys (${errorMessage(err)})`);
    return [];
  }
}

function validateCapabilities(caps, errors) {
  if (!isPlainObject(caps)) {
    errors.push("capabilities must be an object");
    return;
  }
  for (const key of safeKeys(caps, "capabilities", errors)) {
    if (!CAPABILITY_KEYS.includes(key)) errors.push(`capabilities.${key} is not a known key`);
  }
  for (const key of CAPABILITY_KEYS) {
    const label = `capabilities.${key}`;
    if (!safeHas(caps, key, label, errors)) {
      errors.push(`capabilities.${key} is missing`);
      continue;
    }
    const value = safeGet(caps, key, label, errors);
    if (key === "systemPrompt") {
      if (!SYSTEM_PROMPT_MODES.includes(value)) {
        errors.push(`capabilities.systemPrompt must be one of: ${SYSTEM_PROMPT_MODES.join(", ")}`);
      }
    } else if (typeof value !== "boolean") {
      errors.push(`capabilities.${key} must be a boolean`);
    }
  }
}

/**
 * Check a plugin object against the v1 contract.
 * @param {unknown} plugin
 * @param {{ expectId?: string, builtIn?: boolean }} [opts]
 * @returns {string[]} error messages; an empty array means valid
 */
function validateHarnessPlugin(plugin, opts = {}) {
  try {
    return checkPlugin(plugin, opts || {});
  } catch (err) {
    // Last resort, for example a revoked Proxy: report instead of throw.
    return [`plugin: cannot read the plugin object (${errorMessage(err)})`];
  }
}

function checkPlugin(plugin, { expectId, builtIn = false }) {
  if (!isPlainObject(plugin)) return ["plugin must be a non-null object"];
  const errors = [];
  const get = (key) => safeGet(plugin, key, key, errors);

  if (get("apiVersion") !== API_VERSION) {
    errors.push(`apiVersion must be ${API_VERSION}`);
  }

  const id = get("id");
  if (typeof id !== "string" || !ID_RE.test(id)) {
    errors.push(`id must match ${ID_RE}`);
  } else {
    if (expectId !== undefined && id !== expectId) {
      errors.push(`id "${id}" must equal the folder name "${expectId}"`);
    }
    if (!builtIn && BUILTIN_HARNESS_IDS.includes(id)) {
      errors.push(`id "${id}" is reserved for a built-in harness`);
    }
  }

  const displayName = get("displayName");
  if (displayName !== undefined
      && (typeof displayName !== "string" || displayName.trim() === "")) {
    errors.push("displayName must be a non-empty string when present");
  }

  const capabilities = get("capabilities");
  validateCapabilities(capabilities, errors);

  for (const name of REQUIRED_METHODS) {
    if (typeof get(name) !== "function") errors.push(`${name} must be a function`);
  }
  if (isPlainObject(capabilities) && safeGet(capabilities, "providers", "capabilities.providers", []) === true) {
    for (const name of PROVIDER_METHODS) {
      if (typeof get(name) !== "function") {
        errors.push(`${name} must be a function when capabilities.providers is true`);
      }
    }
  }
  for (const name of OPTIONAL_METHODS) {
    const method = get(name);
    if (method !== undefined && typeof method !== "function") {
      errors.push(`${name} must be a function when present`);
    }
  }

  for (const key of safeKeys(plugin, "plugin", errors)) {
    if (!ALLOWED_KEYS.includes(key)) errors.push(`${key} is not a known plugin key`);
  }
  return errors;
}

/**
 * Turn a list of strings or { value, label } items into Choice[]. Invalid
 * items and duplicate values are dropped; the order stays.
 * @param {unknown} list
 * @returns {Choice[]}
 */
function normalizeChoices(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    let choice = null;
    if (typeof item === "string") {
      if (item !== "") choice = { value: item, label: item };
    } else if (isPlainObject(item) && typeof item.value === "string" && item.value !== "") {
      const label = typeof item.label === "string" && item.label !== "" ? item.label : item.value;
      choice = { value: item.value, label };
    }
    if (!choice || seen.has(choice.value)) continue;
    seen.add(choice.value);
    out.push(choice);
  }
  return out;
}

module.exports = {
  API_VERSION,
  BUILTIN_HARNESS_IDS,
  SYSTEM_PROMPT_MODES,
  ID_RE,
  validateHarnessPlugin,
  normalizeChoices,
};
