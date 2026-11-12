"use strict";

// Pipeline file parser. Pure: the caller gives the file text and a sync
// readFile(path) for prompt files. No file reads here.

const path = require("node:path");
const { FormatError, parseYamlFile } = require("./frontmatter");
const { parseTemplate, TemplateError } = require("./template");
const { checkDeclaration } = require("./fields");
const { validateNodeSettings } = require("./pipeline-config");

const TOP_KEYS = ["name", "description", "start", "defaults", "nodes", "edges"];
const NODE_KEYS = ["type", "harness", "model", "effort", "timeLimit", "maxContext", "prompt", "fields", "checks",
  "scripts", "failFast", "required", "checkout", "after"];
const SETTING_KEYS = ["harness", "model", "effort", "timeLimit", "maxContext"];
const ID_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const SCRIPT_KEYS = ["name", "run", "cwd", "timeout", "env", "repos"];
const SCRIPT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const MAX_SCRIPTS = 50;
const MAX_RUN_LENGTH = 4000;
const MAX_SCRIPT_TIMEOUT = 7200;
const DEFAULT_SCRIPT_TIMEOUT = 600;
const CHECKOUTS = ["worktree", "clean"];

function isMapping(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function fail(fileName, message) {
  throw new FormatError(fileName, null, `${fileName}: ${message}`);
}

// Parse prompt text as a template; return the text unchanged.
function checkTemplate(fileName, where, text) {
  try {
    parseTemplate(text);
  } catch (err) {
    if (err instanceof TemplateError) fail(fileName, `${where}: ${err.message}`);
    throw err;
  }
  return text;
}

function readPromptFile(fileName, where, spec, readFile) {
  if (!isMapping(spec) || Object.keys(spec).some((k) => k !== "file")
    || typeof spec.file !== "string" || spec.file.trim() === "") {
    fail(fileName, `${where} must be a string or { file: <relative path> }`);
  }
  const dir = path.resolve(path.dirname(fileName));
  const resolved = path.resolve(dir, spec.file);
  const rel = path.relative(dir, resolved);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    fail(fileName, `${where}: file '${spec.file}' is outside the folder of the pipeline file`);
  }
  let text;
  try {
    text = readFile(resolved);
  } catch (err) {
    fail(fileName, `${where}: cannot read file '${spec.file}': ${err.message}`);
  }
  if (typeof text !== "string") fail(fileName, `${where}: cannot read file '${spec.file}'`);
  return text;
}

function parsePrompt(fileName, where, value, readFile) {
  const text = typeof value === "string" ? value : readPromptFile(fileName, where, value, readFile);
  return checkTemplate(fileName, where, text);
}

function parseNode(fileName, id, raw, readFile) {
  const where = `node '${id}'`;
  if (!isMapping(raw)) fail(fileName, `${where} must be a mapping`);
  for (const key of Object.keys(raw)) {
    if (!NODE_KEYS.includes(key)) {
      fail(fileName, `${where}: unknown key '${key}' (allowed: ${NODE_KEYS.join(", ")})`);
    }
  }
  if (typeof raw.type !== "string" || raw.type === "") fail(fileName, `${where}: type is required`);
  const settingsError = validateNodeSettings(where, raw);
  if (settingsError) fail(fileName, settingsError);

  const node = { type: raw.type };
  for (const key of SETTING_KEYS) {
    if (key in raw) node[key] = raw[key];
  }
  if ("prompt" in raw) node.prompt = parsePrompt(fileName, `${where} prompt`, raw.prompt, readFile);

  if ("fields" in raw) {
    if (!isMapping(raw.fields)) fail(fileName, `${where}: fields must be a mapping`);
    for (const [name, decl] of Object.entries(raw.fields)) {
      const errors = checkDeclaration(name, decl);
      if (errors.length) fail(fileName, `${where}: ${errors[0]}`);
    }
    node.fields = raw.fields;
  }
  if ("checks" in raw) {
    if (!Array.isArray(raw.checks)) fail(fileName, `${where}: checks must be a list of node ids`);
    for (const c of raw.checks) {
      if (typeof c !== "string" || !ID_RE.test(c)) {
        fail(fileName, `${where}: checks entry ${JSON.stringify(c)} is not a node id`);
      }
    }
    node.checks = raw.checks.slice();
  }
  if ("after" in raw) {
    if (!Array.isArray(raw.after) || raw.after.length === 0) {
      fail(fileName, `${where}: after must be a non-empty list of node ids`);
    }
    for (const a of raw.after) {
      if (typeof a !== "string" || !ID_RE.test(a)) {
        fail(fileName, `${where}: after entry ${JSON.stringify(a)} is not a node id`);
      }
    }
    node.after = raw.after.slice();
  }
  if ("scripts" in raw) parseScriptSettings(fileName, where, raw, node);
  for (const key of ["failFast", "required"]) {
    if (key in raw && typeof raw[key] !== "boolean") fail(fileName, `${where}: ${key} must be true or false`);
  }
  if ("checkout" in raw && !CHECKOUTS.includes(raw.checkout)) {
    fail(fileName, `${where}: checkout must be one of: ${CHECKOUTS.join(", ")}`);
  }
  // Keys set on a node without scripts stay as written: rule R11 rejects them.
  for (const key of ["failFast", "required", "checkout"]) if (key in raw) node[key] = raw[key];
  if ("scripts" in raw) {
    if (node.failFast === undefined) node.failFast = true;
    if (node.required === undefined) node.required = false;
    if (node.checkout === undefined) node.checkout = "worktree";
  }
  return node;
}

// A relative path inside the run root, normalized: "./a/" -> "a".
function normalizeCwd(fileName, where, cwd) {
  if (typeof cwd !== "string" || cwd === "") fail(fileName, `${where}: cwd must be a non-empty string`);
  if (cwd.includes("\\")) fail(fileName, `${where}: cwd must not contain a backslash`);
  if (cwd.startsWith("/")) fail(fileName, `${where}: cwd must be a relative path`);
  const parts = cwd.split("/");
  if (parts.includes("..")) fail(fileName, `${where}: cwd must not contain a '..' segment`);
  const kept = parts.filter((p) => p !== "" && p !== ".");
  return kept.length ? kept.join("/") : ".";
}

function parseScript(fileName, where, raw, names) {
  if (!isMapping(raw)) fail(fileName, `${where} must be a mapping`);
  for (const key of Object.keys(raw)) {
    if (!SCRIPT_KEYS.includes(key)) {
      fail(fileName, `${where}: unknown key '${key}' (allowed: ${SCRIPT_KEYS.join(", ")})`);
    }
  }
  if (typeof raw.name !== "string" || !SCRIPT_NAME_RE.test(raw.name)) {
    fail(fileName, `${where}: name is required and must match ${SCRIPT_NAME_RE}`);
  }
  if (names.has(raw.name)) fail(fileName, `${where}: name '${raw.name}' is used twice`);
  names.add(raw.name);
  where = `${where} '${raw.name}'`;
  if (typeof raw.run !== "string" || raw.run.trim() === "") fail(fileName, `${where}: run is required: a non-empty string`);
  if (raw.run.length > MAX_RUN_LENGTH) fail(fileName, `${where}: run is longer than ${MAX_RUN_LENGTH} characters`);
  const script = { name: raw.name, run: raw.run, timeout: DEFAULT_SCRIPT_TIMEOUT };
  if ("cwd" in raw) script.cwd = normalizeCwd(fileName, where, raw.cwd);
  if ("timeout" in raw) {
    if (!Number.isInteger(raw.timeout) || raw.timeout < 1 || raw.timeout > MAX_SCRIPT_TIMEOUT) {
      fail(fileName, `${where}: timeout must be an integer number of seconds from 1 to ${MAX_SCRIPT_TIMEOUT}`);
    }
    script.timeout = raw.timeout;
  }
  if ("env" in raw) {
    if (!isMapping(raw.env)) fail(fileName, `${where}: env must be a mapping`);
    for (const [key, value] of Object.entries(raw.env)) {
      if (!ENV_KEY_RE.test(key)) fail(fileName, `${where}: env key '${key}' must match ${ENV_KEY_RE}`);
      if (typeof value !== "string") fail(fileName, `${where}: env '${key}' must be a string`);
    }
    script.env = { ...raw.env };
  }
  if ("repos" in raw) {
    if (!Array.isArray(raw.repos) || raw.repos.length === 0
      || !raw.repos.every((r) => typeof r === "string" && r !== "")) {
      fail(fileName, `${where}: repos must be a non-empty list of non-empty strings`);
    }
    script.repos = raw.repos.slice();
  }
  return script;
}

function parseScriptSettings(fileName, where, raw, node) {
  if (!Array.isArray(raw.scripts) || raw.scripts.length < 1 || raw.scripts.length > MAX_SCRIPTS) {
    fail(fileName, `${where}: scripts must be a list of 1 to ${MAX_SCRIPTS} mappings`);
  }
  const names = new Set();
  node.scripts = raw.scripts.map((s, i) => parseScript(fileName, `${where}: scripts[${i}]`, s, names));
}

// "a" or "[a, b]" -> { ids } or { error }.
function parseSide(text) {
  const t = text.trim();
  const isList = t.startsWith("[") && t.endsWith("]");
  const parts = isList ? t.slice(1, -1).split(",") : [t];
  const ids = [];
  for (const part of parts) {
    const id = part.trim();
    if (id === "") return { error: isList ? "empty entry in a list of nodes" : "missing node id" };
    if (!ID_RE.test(id)) return { error: `'${id}' is not a node id` };
    ids.push(id);
  }
  return { ids };
}

// In YAML, an unquoted item "- a -> b: x, y" is read as a one-key mapping
// { "a -> b": "x, y" }. Turn it back into the edge text.
function edgeToText(item) {
  if (isMapping(item) && Object.keys(item).length === 1) {
    const [key] = Object.keys(item);
    const value = item[key];
    return `${key}: ${value === null ? "" : value}`;
  }
  return item;
}

function parseEdge(fileName, index, text) {
  const bad = (msg) => fail(fileName, `edge ${index} '${text}': ${msg}`);
  if (typeof text !== "string") bad("an edge must be a string '<from> -> <to>: <interaction>[, ...]'");
  const arrow = text.indexOf("->");
  if (arrow < 0) bad("missing '->'");
  const colon = text.indexOf(":", arrow + 2);
  if (colon < 0) bad("missing ':' and the interaction names");
  const from = parseSide(text.slice(0, arrow));
  if (from.error) bad(`bad source: ${from.error}`);
  const to = parseSide(text.slice(arrow + 2, colon));
  if (to.error) bad(`bad target: ${to.error}`);
  const names = text.slice(colon + 1).split(",").map((s) => s.trim());
  if (names.some((n) => n === "")) bad("empty interaction name");
  const badName = names.find((n) => !ID_RE.test(n));
  if (badName !== undefined) bad(`'${badName}' is not an interaction name`);
  if (new Set(names).size !== names.length) bad("an interaction name is listed twice");
  return { from: from.ids, to: to.ids, names };
}

function parsePipeline(text, fileName, readFile) {
  const raw = parseYamlFile(text, fileName);
  if (!isMapping(raw)) fail(fileName, "the file must be a YAML mapping");
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.includes(key)) {
      fail(fileName, `unknown key '${key}' (allowed: ${TOP_KEYS.join(", ")})`);
    }
  }
  if (typeof raw.name !== "string" || raw.name.trim() === "") fail(fileName, "name is required: a non-empty string");
  if ("description" in raw && typeof raw.description !== "string") fail(fileName, "description must be a string");
  if (typeof raw.start !== "string" || !ID_RE.test(raw.start)) fail(fileName, "start is required: a node id");

  const defaults = {};
  if ("defaults" in raw) {
    if (!isMapping(raw.defaults)) fail(fileName, "defaults must be a mapping");
    for (const key of Object.keys(raw.defaults)) {
      if (key !== "prompt") fail(fileName, `unknown key '${key}' in defaults (allowed: prompt)`);
    }
    if ("prompt" in raw.defaults) {
      defaults.prompt = parsePrompt(fileName, "defaults prompt", raw.defaults.prompt, readFile);
    }
  }

  if (!isMapping(raw.nodes) || Object.keys(raw.nodes).length === 0) {
    fail(fileName, "nodes is required: a mapping with at least one node");
  }
  const nodes = {};
  for (const [id, rawNode] of Object.entries(raw.nodes)) {
    if (!ID_RE.test(id)) fail(fileName, `node id '${id}' must match ${ID_RE}`);
    nodes[id] = parseNode(fileName, id, rawNode, readFile);
  }

  const rawEdges = raw.edges === undefined ? [] : raw.edges;
  if (!Array.isArray(rawEdges)) fail(fileName, "edges must be a list of strings");
  const edges = [];
  const seen = new Map(); // "from\0to" -> index of the edge that made it
  rawEdges.forEach((edgeText, index) => {
    edgeText = edgeToText(edgeText);
    const { from, to, names } = parseEdge(fileName, index, edgeText);
    for (const f of from) {
      for (const t of to) {
        const key = `${f}\0${t}`;
        if (seen.has(key)) {
          fail(fileName, `edge ${index} '${edgeText}': a second edge for ${f} -> ${t} (first in edge ${seen.get(key)}); join them in one edge`);
        }
        seen.set(key, index);
        edges.push({ from: f, to: t, interactions: names.slice() });
      }
    }
  });

  return {
    name: raw.name,
    description: "description" in raw ? raw.description : null,
    start: raw.start,
    defaults,
    nodes,
    edges,
  };
}

module.exports = { parsePipeline };
