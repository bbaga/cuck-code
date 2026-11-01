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

const FLOW_INTERACTIONS = "interactions";

function isOldStyleRequest(r) {
  return !!r && typeof r === "object" && !!r.source && r.flow !== FLOW_INTERACTIONS;
}

// The text that replaces an old validation request that cannot be restored.
function unrestorableRequestNotice(name, requestId) {
  return `An older validation request for implementor '${name}' (${requestId || "no id"}) could not be restored. `
    + "The planner must check the instance and call start on a validator node, or call accept.";
}

// The text that tells the planner a deferred validation did not start.
function deferredValidationNotice(item, impl, validatorNode) {
  const target = validatorNode ? `the validator node '${validatorNode}'` : "the validator node of this implementor";
  return `VALIDATION NOT STARTED - the validation of implementor '${impl.name}' (workerId ${impl.id}) `
    + "was waiting for a free worker slot when the router restarted, and did not start.\n\n"
    + `ACCEPTANCE CRITERIA (as given earlier):\n${typeof item.criteria === "string" ? item.criteria : ""}\n\n`
    + `Call start on ${target} with these criteria and implementor ${impl.id} as source, `
    + "or call accept to accept the work without validation.";
}

// Normalize a loaded line. Pure and idempotent: every step skips what an
// earlier run already converted, and no data is dropped except a queued
// request or a deferred validation whose worker no longer exists (logged).
// opts: { renderReport(worker, line) -> string|null, log(level, event, fields), now() }.
function normalizeLine(meta, resolvedDefault, opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const note = (level, fields) => log(level, "boot.migrate", { lineId: meta && meta.id, at: now(), ...fields });
  const out = JSON.parse(JSON.stringify(meta || {}));
  const hadGraph = !!out.graph;
  if (!hadGraph) {
    out.graph = JSON.parse(JSON.stringify(resolvedDefault));
    out.nodeSettings = {};
  }
  if (!out.nodeSettings || typeof out.nodeSettings !== "object") out.nodeSettings = {};
  const graph = out.graph;
  const nodes = (graph && graph.nodes) || {};
  if (!Array.isArray(out.workers)) out.workers = [];

  // 1. Legacy per-phase pipeline -> per-node settings. An existing entry wins.
  const legacy = out.pipeline && typeof out.pipeline === "object" ? out.pipeline : {};
  for (const [phase, settings] of Object.entries(legacy)) {
    if (!settings || typeof settings !== "object") continue;
    for (const [id, node] of Object.entries(nodes)) {
      if (phaseOfType(graph, node.type) !== phase || has(out.nodeSettings, id)) continue;
      const copy = { ...settings };
      const type = graph.types && graph.types[node.type];
      if (type && type.session === "fresh") delete copy.maxContext;
      out.nodeSettings[id] = copy;
      note("info", { step: "pipeline-to-node-settings", phase, node: id });
    }
  }

  // 3. Every worker gets a node; a node that is not in the graph is kept and reported.
  for (const w of out.workers) {
    if (!hadGraph || !w.node) w.node = nodeForWorker(graph, w);
    if (!w.node || !has(nodes, w.node)) {
      note("warn", { step: "worker-node-unknown", workerId: w.id, node: w.node || null });
    }
  }

  // 2. validationSkipped -> acceptedRuns.
  for (const w of out.workers) {
    if (w.role === "validator" || !w.validationSkipped) continue;
    const skipped = w.validationSkipped;
    if (!Array.isArray(w.acceptedRuns)) w.acceptedRuns = [];
    if (w.acceptedRuns.some((a) => a && a.runId === skipped.runId)) continue;
    w.acceptedRuns.push({ runId: skipped.runId, invocationId: skipped.invocationId, by: "migration" });
    note("info", { step: "validation-skipped-to-accepted-run", workerId: w.id, runId: skipped.runId });
  }

  // 4. Old-style planner requests (criteria source, no flow) -> report requests.
  const convertRequest = (r, where) => {
    if (!isOldStyleRequest(r)) return r;
    const worker = out.workers.find((w) => w.id === r.source.workerId);
    if (!worker) {
      note("warn", { step: "planner-request-dropped", where, requestId: r.id || null,
        workerId: r.source.workerId, reason: "worker is gone" });
      return null;
    }
    let text = null;
    try {
      if (worker.status === "completed" && typeof opts.renderReport === "function") text = opts.renderReport(worker, out);
    } catch (error) {
      note("warn", { step: "planner-request-render-failed", where, requestId: r.id || null,
        workerId: worker.id, error: String(error && error.message || error) });
    }
    if (typeof text !== "string" || !text) {
      text = unrestorableRequestNotice(worker.name, r.id);
      note("warn", { step: "planner-request-to-notice", where, requestId: r.id || null,
        workerId: worker.id, reason: "no completed run to report" });
    }
    const next = { text, flow: FLOW_INTERACTIONS };
    for (const key of ["id", "noticeId", "recorded"]) if (r[key] !== undefined) next[key] = r[key];
    note("info", { step: "planner-request-to-report", where, requestId: r.id || null, workerId: worker.id });
    return next;
  };
  if (Array.isArray(out.plannerQueue)) {
    out.plannerQueue = out.plannerQueue.map((r) => convertRequest(r, "queue")).filter((r) => r !== null);
  }
  if (out.activePlannerRequest) {
    const active = convertRequest(out.activePlannerRequest, "active");
    if (active === null) delete out.activePlannerRequest; else out.activePlannerRequest = active;
  }

  // 5. Deferred validations -> one planner request each, then clear the list.
  if (Array.isArray(out.pendingValidations) && out.pendingValidations.length) {
    if (!Array.isArray(out.plannerQueue)) out.plannerQueue = [];
    for (const item of out.pendingValidations) {
      const impl = item && out.workers.find((w) => w.id === item.implWorkerId);
      if (!impl) {
        note("warn", { step: "pending-validation-dropped", workerId: item && item.implWorkerId || null,
          reason: "implementor is gone" });
        continue;
      }
      out.plannerQueue.push({ id: `migrated-validation-${impl.id}-${item.invocationId || item.runId}`,
        text: deferredValidationNotice(item, impl, validatorNodeFor(graph, impl.node)),
        flow: FLOW_INTERACTIONS });
      note("info", { step: "pending-validation-to-request", workerId: impl.id, runId: item.runId });
    }
  }
  out.pendingValidations = [];
  return out;
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

module.exports = { PHASE_TYPES, phaseOfType, migrateLine, normalizeLine, nodeSettingsFromPipeline,
  graphView, nodeSettingsFields, builtinPipelineNames,
  implementorNodeFor, validatorNodeFor, integrationNodeFor, loadBuiltinPipeline };
