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

// The old per-phase mirror of node settings: for each phase, the settings of
// the first node of that phase (in graph order) that has any. Null if none.
function pipelineFromNodeSettings(graph, nodeSettings) {
  const out = {};
  for (const [id, node] of Object.entries(graph.nodes)) {
    const phase = phaseOfType(graph, node.type);
    if (phase && !has(out, phase) && has(nodeSettings, id)) out[phase] = { ...nodeSettings[id] };
  }
  return Object.keys(out).length ? out : null;
}

// The graph as the API shows it: name, start, nodes with type and phase, edges.
// Each edge also carries `kinds`: for every interaction name its { effect,
// trigger } from the resolved interactions, so a client can lay the graph out.
// `freshNodes` lists the nodes whose type starts a fresh session on every turn.
function graphView(graph) {
  if (!graph) return null;
  const nodes = {};
  const freshNodes = [];
  for (const [id, node] of Object.entries(graph.nodes || {})) {
    nodes[id] = { type: node.type, phase: phaseOfType(graph, node.type) };
    const type = graph.types && graph.types[node.type];
    if (type && type.session === "fresh") freshNodes.push(id);
  }
  const edges = (graph.edges || []).map((edge) => {
    const kinds = {};
    for (const name of edge.interactions || []) {
      const it = graph.interactions && graph.interactions[name];
      kinds[name] = { effect: it ? it.effect || null : null, trigger: it ? it.trigger || null : null };
    }
    return { ...JSON.parse(JSON.stringify(edge)), kinds };
  });
  return { name: graph.name, start: graph.start, nodes, edges, freshNodes };
}

// The node fields of an API response: graph, stored node settings and the
// effective settings per node.
function nodeSettingsFields(line, env) {
  const { resolveNodeSettings } = require("./pipeline-config");
  if (!line.graph) return {};
  const effective = {};
  for (const id of Object.keys(line.graph.nodes)) effective[id] = resolveNodeSettings(line, id, env);
  return { graph: graphView(line.graph), nodeSettings: line.nodeSettings || {},
    effectiveNodeSettings: effective };
}

// Names of the built-in pipeline files.
function builtinPipelineNames(fs, root) {
  return fs.readdirSync(path.join(root, "pipelines"), { withFileTypes: true })
    .map((e) => /^(.+)\.yaml$/.exec(e.name)).filter(Boolean).map((m) => m[1]).sort();
}

// The node an implementor of this persona runs on: backend-impl or
// frontend-impl, if the graph has that node with an implementor type.
function implementorNodeFor(graph, persona) {
  const id = persona === "frontend" ? "frontend-impl" : "backend-impl";
  const node = graph && graph.nodes && has(graph.nodes, id) ? graph.nodes[id] : null;
  return node && phaseOfType(graph, node.type) === "implementor" ? id : null;
}

// The validator node that checks the given implementor node.
function validatorNodeFor(graph, implementorNode) {
  const nodes = (graph && graph.nodes) || {};
  return Object.keys(nodes).find((id) => phaseOfType(graph, nodes[id].type) === "validator"
    && Array.isArray(nodes[id].checks) && nodes[id].checks.includes(implementorNode)) || null;
}

// The node whose type has the integration phase (root type integration-validator).
function integrationNodeFor(graph) {
  const nodes = (graph && graph.nodes) || {};
  return Object.keys(nodes).find((id) => phaseOfType(graph, nodes[id].type) === "integration") || null;
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

module.exports = { PHASE_TYPES, phaseOfType, migrateLine, nodeSettingsFromPipeline,
  pipelineFromNodeSettings, graphView, nodeSettingsFields, builtinPipelineNames,
  implementorNodeFor, validatorNodeFor, integrationNodeFor, loadBuiltinPipeline };
