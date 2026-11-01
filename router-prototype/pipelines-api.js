"use strict";

// Helpers of the /api/pipelines routes: name rules, text checks, validation
// against a catalog, listings, the graph preview, and the only code that writes
// into <managedDir>/pipelines/. File access goes through the injected `fs`.

const path = require("node:path");
const YAML = require("yaml");
const { parsePipeline } = require("./pipelines");
const { resolvePipelineDefinition, PipelineError } = require("./resolve-pipeline");
const { phaseOfType } = require("./line-graph");

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const MAX_TEXT_BYTES = 256 * 1024;
// The JSON body limit of the write routes: the text limit plus room for JSON escapes.
const MAX_BODY_BYTES = 300 * 1024;

function has(obj, key) {
  return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

// Returns an error message, or null.
function nameError(name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return "a pipeline name has 1-60 characters of a-z, 0-9 and '-', and starts with a letter or digit";
  }
  return null;
}

// Returns { status, message } or null.
function textError(text) {
  if (typeof text !== "string") return { status: 400, message: "text must be a string" };
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    return { status: 413, message: `text is larger than ${MAX_TEXT_BYTES / 1024} KB` };
  }
  return null;
}

function managedFile(managedDir, name) {
  const dir = path.resolve(managedDir, "pipelines");
  const file = path.resolve(dir, `${name}.yaml`);
  if (nameError(name) || path.dirname(file) !== dir) throw new Error(`unsafe pipeline name '${name}'`);
  return file;
}

// The catalog with the candidate text standing in for pipeline `name`.
function catalogWithText(catalog, name, text, managedDir) {
  return { ...catalog,
    pipelines: { ...catalog.pipelines, [name]: { text, file: managedFile(managedDir, name), layer: "managed" } } };
}

// Validate pipeline text exactly as a line creation would: parse it, then
// resolve it against the live catalog with the text substituted for its name.
// Returns { errors: [{ rule, message }], resolved: object|null, name: string|null }.
function validateText({ text, expectName, catalog, managedDir, builtInNames = [] }) {
  const bad = textError(text);
  if (bad) return { errors: [{ rule: "LOAD", message: bad.message }], resolved: null, name: null };
  const fileName = `pipelines/${expectName || "candidate"}.yaml`;
  let parsed;
  try {
    parsed = parsePipeline(text, fileName, catalog.readFile);
  } catch (err) {
    return { errors: [{ rule: "LOAD", message: err.message }], resolved: null, name: null };
  }
  const name = parsed.name;
  const errors = [];
  const nameMessage = nameError(name);
  if (nameMessage) {
    errors.push({ rule: "NAME", message: `name '${name}': ${nameMessage}` });
    return { errors, resolved: null, name };
  }
  if (expectName !== undefined && name !== expectName) {
    errors.push({ rule: "NAME", message: `the name in the text ('${name}') must equal '${expectName}'` });
  }
  if (builtInNames.includes(name) || (has(catalog.pipelines, name) && catalog.pipelines[name].layer !== "managed")) {
    const layer = builtInNames.includes(name) ? "built-in" : catalog.pipelines[name].layer;
    errors.push({ rule: "NAME", message: `'${name}' is a ${layer} pipeline and cannot be replaced; duplicate it under a new name` });
  }
  let resolved = null;
  try {
    resolved = resolvePipelineDefinition(name, catalogWithText(catalog, name, text, managedDir));
  } catch (err) {
    if (err instanceof PipelineError) errors.push(...err.errors);
    else errors.push({ rule: "LOAD", message: err.message });
  }
  return { errors, resolved: errors.length ? null : resolved, name };
}

// The preview graph: { nodes: [{ id, type, phase }], edges: [{ from, to, interactions }] }.
function graphPreview(resolved) {
  if (!resolved) return null;
  return {
    nodes: Object.entries(resolved.nodes).map(([id, n]) => ({ id, type: n.type, phase: phaseOfType(resolved, n.type) })),
    edges: resolved.edges.map((e) => ({ from: e.from, to: e.to, interactions: [...e.interactions] })),
  };
}

// resolve(name) throws like resolvePipelineDefinition. Returns { resolved, errors }.
function resolveSafe(resolve, name) {
  try {
    return { resolved: resolve(name), errors: [] };
  } catch (err) {
    return { resolved: null, errors: err instanceof PipelineError ? err.errors : [{ rule: "LOAD", message: err.message }] };
  }
}

// The list answer: pipelines, node types and interactions.
function buildListing(catalog, resolve) {
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const pipelines = Object.entries(catalog.pipelines).map(([name, entry]) => {
    const { resolved, errors } = resolveSafe(resolve, name);
    return { name, description: resolved ? resolved.description : null, layer: entry.layer,
      editable: entry.layer === "managed", problems: errors };
  }).sort(byName);
  const nodeTypes = Object.entries(catalog.types).map(([name, e]) => ({ name, layer: e.layer })).sort(byName);
  const interactions = Object.entries(catalog.interactions).map(([name, e]) => ({ name, layer: e.layer })).sort(byName);
  return { pipelines, nodeTypes, interactions,
    problems: catalog.problems.map((p) => ({ layer: p.layer, path: p.path, errors: p.errors })) };
}

// The text of pipeline `name` in the managed layer even when the catalog dropped it (a broken file).
function readManagedText(fs, managedDir, name) {
  try { return fs.readFileSync(managedFile(managedDir, name), "utf8"); } catch { return null; }
}

// The text with the value of `name:` replaced. Everything else stays byte for byte.
function renameInText(text, newName) {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  const node = doc.get("name", true);
  if (!node || !node.range) throw new Error("the pipeline text has no name");
  return text.slice(0, node.range[0]) + YAML.stringify(newName).trim() + text.slice(node.range[1]);
}

// Atomic write into <managedDir>/pipelines/<name>.yaml. `write(file, text)` writes through a temp file and rename.
function writeManagedPipeline({ fs, managedDir, name, text, write }) {
  const file = managedFile(managedDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existed = fs.existsSync(file);
  write(file, text);
  return { file, created: !existed };
}

// Remove <managedDir>/pipelines/<name>.yaml. Returns false when there is no such file.
function deleteManagedPipeline({ fs, managedDir, name }) {
  const file = managedFile(managedDir, name);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

module.exports = { NAME_RE, MAX_TEXT_BYTES, MAX_BODY_BYTES, nameError, textError, validateText, graphPreview,
  buildListing, resolveSafe, readManagedText, renameInText, writeManagedPipeline, deleteManagedPipeline,
  managedFile };
