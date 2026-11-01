"use strict";

// Store the pipeline graph on a line, and migrate lines saved without one.
// migrateLine is pure. loadBuiltinPipeline reads files with the fs it is given.

const path = require("node:path");
const { resolvePipelineDefinition } = require("./resolve-pipeline");

const PHASE_TYPES = {
  planner: "planner",
  implementor: "implementor",
  validator: "validator",
  integration: "integration-validator",
};

function has(obj, key) {
  return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

// The phase of a node type: follow `extends` to the root type, then map the root.
function phaseOfType(resolved, typeName) {
  const types = (resolved && resolved.types) || {};
  const seen = new Set();
  let name = typeName;
  while (has(types, name) && types[name].extends !== undefined && !seen.has(name)) {
    seen.add(name);
    name = types[name].extends;
  }
  for (const [phase, root] of Object.entries(PHASE_TYPES)) if (root === name) return phase;
  return null;
}

function nodeForWorker(resolved, w) {
  const nodes = (resolved && resolved.nodes) || {};
  const pick = (phase, preferred) => {
    if (has(nodes, preferred) && phaseOfType(resolved, nodes[preferred].type) === phase) return preferred;
    return Object.keys(nodes).find((id) => phaseOfType(resolved, nodes[id].type) === phase) || null;
  };
  const frontend = w.persona === "frontend";
  if (w.role === "validator") {
    if (w.kind === "integration") return pick("integration", "integration");
    return pick("validator", frontend ? "frontend-val" : "backend-val");
  }
  return pick("implementor", frontend ? "frontend-impl" : "backend-impl");
}

// Copy the old per-phase overrides to every node whose type maps to the phase.
function nodeSettingsFromPipeline(graph, pipeline) {
  const out = {};
  const old = pipeline && typeof pipeline === "object" ? pipeline : {};
  for (const [phase, settings] of Object.entries(old)) {
    if (!settings || typeof settings !== "object") continue;
    for (const [id, node] of Object.entries(graph.nodes)) {
      if (phaseOfType(graph, node.type) === phase) out[id] = { ...settings };
    }
  }
  return out;
}

function migrateLine(meta, resolvedDefault) {
  if (meta && meta.graph) return meta;
  const graph = JSON.parse(JSON.stringify(resolvedDefault));
  const nodeSettings = nodeSettingsFromPipeline(graph, meta && meta.pipeline);
  const workers = (meta.workers || []).map((w) => {
    const out = { ...w, node: nodeForWorker(graph, w) };
    if (w.role !== "validator" && w.validationSkipped) {
      out.acceptedRuns = [{ runId: w.validationSkipped.runId,
        invocationId: w.validationSkipped.invocationId, by: "migration" }];
    }
    return out;
  });
  return { ...meta, graph, nodeSettings, workers };
}

// Build a catalog from the three built-in folders and resolve one pipeline.
function loadBuiltinPipeline(name, fs, root) {
  const list = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  const types = {};
  for (const e of list("node-types")) {
    if (e.isDirectory()) types[e.name] = { folder: path.join(root, "node-types", e.name), layer: "built-in" };
  }
  const interactions = {};
  for (const e of list("interactions")) {
    if (e.isDirectory()) {
      interactions[e.name] = { folder: path.join(root, "interactions", e.name), layer: "built-in", builtIn: true };
    }
  }
  const pipelines = {};
  for (const e of list("pipelines")) {
    const m = /^(.+)\.yaml$/.exec(e.name);
    if (e.isFile() && m) pipelines[m[1]] = { file: path.join(root, "pipelines", e.name), layer: "built-in" };
  }
  const readFile = (p) => fs.readFileSync(p, "utf8");
  return resolvePipelineDefinition(name, { readFile, types, interactions, pipelines });
}

module.exports = { PHASE_TYPES, phaseOfType, migrateLine, nodeSettingsFromPipeline, loadBuiltinPipeline };
