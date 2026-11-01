"use strict";

// Resolve a pipeline: load the pipeline, the node types (with parents) and the
// interactions it uses, check every rule, and return one plain JSON object
// that holds all text. Pure: no file reads here. The catalog gives texts, or
// folders and a readFile(path) function.
//
// catalog = {
//   readFile?: (path) => string,         // needed for folder / file entries
//   types:        { name: { text | folder, layer } },        // NODE.md text, or folder
//   interactions: { name: { text | folder, layer, builtIn? } }, // INTERACTION.md text, or folder
//   pipelines:    { name: { text | file, layer } },
// }

const { loadNodeType, resolveTypes } = require("./node-types");
const { loadInteraction } = require("./interactions");
const { parsePipeline } = require("./pipelines");
const { checkPipeline } = require("./pipeline-rules");
const { requiredFields } = require("./call-fields");

const SETTING_KEYS = ["harness", "model", "effort", "timeLimit", "maxContext"];

class PipelineError extends Error {
  constructor(pipelineName, errors) {
    const list = errors.map((e) => `${e.rule}: ${e.message}`);
    super(`pipeline '${pipelineName}' is not valid:\n- ${list.join("\n- ")}`);
    this.name = "PipelineError";
    this.pipeline = pipelineName;
    this.errors = errors;
  }
}

function has(obj, key) {
  return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

function entryReader(catalog, name, entry, fileName) {
  // Returns { dir, readFile } for an entry given as text or as a folder.
  if (typeof entry.text === "string") {
    return {
      dir: entry.folder || name,
      readFile: (p) => {
        if (p === fileName(entry.folder || name)) return entry.text;
        throw new Error(`no such file '${p}'`);
      },
    };
  }
  if (typeof entry.folder === "string") {
    return {
      dir: entry.folder,
      readFile: (p) => {
        if (typeof catalog.readFile !== "function") throw new Error("the catalog has no readFile function");
        return catalog.readFile(p);
      },
    };
  }
  return null;
}

function resolvePipelineDefinition(name, catalog) {
  const cat = catalog || {};
  const errors = [];
  const fail = (rule, message) => errors.push({ rule, message });
  const guard = (where, fn) => {
    try {
      return fn();
    } catch (err) {
      fail("LOAD", `${where}: ${err.message}`);
      return undefined;
    }
  };
  const fileReader = (p) => {
    if (typeof cat.readFile !== "function") throw new Error("the catalog has no readFile function");
    return cat.readFile(p);
  };

  // 1. The pipeline.
  const pEntry = has(cat.pipelines, name) ? cat.pipelines[name] : undefined;
  if (!pEntry) throw new PipelineError(name, [{ rule: "LOAD", message: `unknown pipeline '${name}'` }]);
  const pipelineText = typeof pEntry.text === "string"
    ? pEntry.text
    : guard(`pipeline '${name}'`, () => fileReader(pEntry.file));
  if (typeof pipelineText !== "string") throw new PipelineError(name, errors.length ? errors : [{ rule: "LOAD", message: `pipeline '${name}' has no text or file` }]);
  const pipeline = guard(`pipeline '${name}'`, () =>
    parsePipeline(pipelineText, pEntry.file || `pipelines/${name}.yaml`, fileReader));
  if (!pipeline) throw new PipelineError(name, errors);

  // 2. Node types used, with their parents.
  const loadedTypes = {};
  const queue = [...new Set(Object.values(pipeline.nodes).map((n) => n.type))];
  while (queue.length) {
    const typeName = queue.shift();
    if (has(loadedTypes, typeName)) continue;
    const entry = has(cat.types, typeName) ? cat.types[typeName] : undefined;
    if (!entry) continue; // unknown type: rule R8 (or resolveTypes, for a parent) reports it
    const reader = entryReader(cat, typeName, entry, (d) => `${d.replace(/[\\/]+$/, "")}/NODE.md`);
    if (!reader) { fail("LOAD", `node type '${typeName}': catalog entry has no text or folder`); continue; }
    const type = guard(`node type '${typeName}'`, () => loadNodeType(reader.dir, reader.readFile));
    if (!type) continue;
    loadedTypes[typeName] = type;
    if (type.extends !== undefined) queue.push(type.extends);
  }
  let resolvedAll = {};
  if (errors.length === 0) {
    resolvedAll = guard("node types", () => resolveTypes(loadedTypes)) || {};
  }

  // 3. Interactions used.
  const interactions = {};
  const used = new Set(pipeline.edges.flatMap((e) => e.interactions));
  for (const iName of used) {
    const entry = has(cat.interactions, iName) ? cat.interactions[iName] : undefined;
    if (!entry) continue; // unknown interaction: rule R8
    if (entry.definition && typeof entry.definition === "object") {
      interactions[iName] = entry.definition; // already loaded (loader-shaped object)
      continue;
    }
    const reader = entryReader(cat, iName, entry, (d) => `${d.replace(/[\\/]+$/, "")}/INTERACTION.md`);
    if (!reader) { fail("LOAD", `interaction '${iName}': catalog entry has no text or folder`); continue; }
    const builtIn = entry.builtIn === true || entry.layer === "built-in";
    const inter = guard(`interaction '${iName}'`, () => loadInteraction(reader.dir, reader.readFile, { builtIn }));
    if (inter) interactions[iName] = inter;
  }

  if (errors.length) throw new PipelineError(name, errors);

  // 4. Rules.
  for (const e of checkPipeline(pipeline, resolvedAll, interactions)) fail(e.rule, e.message);

  // 5. Build the plain definition.
  const usedTypes = {};
  for (const node of Object.values(pipeline.nodes)) {
    if (has(resolvedAll, node.type)) usedTypes[node.type] = resolvedAll[node.type];
  }
  const nodes = {};
  for (const [id, node] of Object.entries(pipeline.nodes)) {
    const settings = {};
    for (const key of SETTING_KEYS) if (key in node) settings[key] = node[key];
    const out = { type: node.type, settings, fields: node.fields || {}, checks: node.checks || [] };
    if (node.prompt !== undefined) out.prompt = node.prompt;
    nodes[id] = out;
  }
  const typeOut = {};
  for (const [tName, type] of Object.entries(usedTypes)) {
    typeOut[tName] = has(cat.types, tName) && cat.types[tName].layer !== undefined
      ? { ...type, layer: cat.types[tName].layer } : type;
  }
  const interOut = {};
  for (const [iName, inter] of Object.entries(interactions)) {
    interOut[iName] = cat.interactions[iName].layer !== undefined
      ? { ...inter, layer: cat.interactions[iName].layer } : inter;
  }
  const result = {
    name: pipeline.name,
    description: pipeline.description,
    layer: pEntry.layer,
    start: pipeline.start,
    defaults: pipeline.defaults,
    nodes,
    edges: pipeline.edges,
    types: typeOut,
    interactions: interOut,
  };

  // 6. Field conflicts of every request-triggered call.
  const draft = JSON.parse(JSON.stringify(result));
  if (errors.length === 0) {
    for (const edge of draft.edges) {
      for (const iName of edge.interactions) {
        if (draft.interactions[iName].trigger !== "request") continue;
        try {
          requiredFields(draft, iName, edge.to);
        } catch (err) {
          fail("CALL", `edge ${edge.from} -> ${edge.to}, interaction '${iName}': ${err.message}`);
        }
      }
    }
  }
  if (errors.length) throw new PipelineError(name, errors);
  return draft;
}

module.exports = { resolvePipelineDefinition, PipelineError };
