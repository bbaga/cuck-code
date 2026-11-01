"use strict";

// Pipeline file parser. Pure: the caller gives the file text and a sync
// readFile(path) for prompt files. No file reads here.

const path = require("node:path");
const { FormatError, parseYamlFile } = require("./frontmatter");
const { parseTemplate, TemplateError } = require("./template");
const { checkDeclaration } = require("./fields");
const { validateNodeSettings } = require("./pipeline-config");

const TOP_KEYS = ["name", "description", "start", "defaults", "nodes", "edges"];
const NODE_KEYS = ["type", "harness", "model", "effort", "timeLimit", "maxContext", "prompt", "fields", "checks"];
const SETTING_KEYS = ["harness", "model", "effort", "timeLimit", "maxContext"];
const ID_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

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
  return node;
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
