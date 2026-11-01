"use strict";

// Reports as interactions (task C6): when a run ends, render the
// complete-triggered interactions on the edges that leave the node of the
// worker. Pure: the caller passes the line graph, the worker and the run data.

const { render } = require("./template");
const { phaseOfType } = require("./line-graph");
const { reportBody } = require("./handoff");

const OUTCOMES = ["done", "pass", "reject", "missing", "timeout", "failed", "stopped"];
const KINDS = ["implementor", "validator", "integration"];

function has(obj, key) {
  return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

// The complete-triggered interactions on the edges that leave `nodeId`:
// [{ name, interaction, to }].
function completeInteractions(graph, nodeId) {
  if (!graph || !graph.edges || !graph.interactions || typeof nodeId !== "string") return [];
  const out = [];
  for (const edge of graph.edges) {
    if (!edge || edge.from !== nodeId) continue;
    for (const name of edge.interactions || []) {
      const interaction = has(graph.interactions, name) ? graph.interactions[name] : null;
      if (interaction && interaction.trigger === "complete") {
        out.push({ name, interaction, to: edge.to });
      }
    }
  }
  return out;
}

// The kind of a worker's node: the phase of its root type, or null.
function kindOfNode(graph, nodeId) {
  if (!graph || !has(graph.nodes, nodeId)) return null;
  const phase = phaseOfType(graph, graph.nodes[nodeId].type);
  return KINDS.includes(phase) ? phase : null;
}

// The outcome of a run. `timedOut` is true for a timeout that nobody asked for.
function outcomeOf(graph, worker, timedOut) {
  if (worker.status === "completed") {
    const type = has(graph.nodes, worker.node) && has(graph.types, graph.nodes[worker.node].type)
      ? graph.types[graph.nodes[worker.node].type] : null;
    const verdictType = type ? type.outcome === "verdict" : worker.role === "validator";
    if (!verdictType) return "done";
    if (worker.verdict === "pass") return "pass";
    if (worker.verdict === "fail") return "reject";
    return "missing";
  }
  if (timedOut) return "timeout";
  return worker.status === "failed" ? "failed" : "stopped";
}

function flags(names, active) {
  const out = {};
  for (const name of names) out[name] = name === active;
  return out;
}

// The router values of the report template.
function reportValues({ graph, worker, source, report, timedOut }) {
  const kind = kindOfNode(graph, worker.node);
  const outcome = outcomeOf(graph, worker, timedOut);
  const completed = worker.status === "completed";
  const label = completed
    ? { implementor: "assistant report", validator: "validation report", integration: "integration report" }[kind]
    : { implementor: "implementor run output", validator: "validation run output",
      integration: "integration run output" }[kind];
  return {
    outcome: flags(OUTCOMES, outcome),
    from: {
      node: worker.node,
      type: flags(KINDS, kind),
      name: worker.name,
      id: worker.id,
      harness: worker.harness || "vibe",
      session: worker.sessionId || "unknown",
      branch: worker.branch,
      error: completed ? "" : (worker.lastError || ""),
    },
    source: {
      name: source ? source.name : "unknown",
      id: worker.validates || (source && source.id) || "unknown",
      harness: (source && source.harness) || "vibe",
      session: (source && source.sessionId) || "unknown",
    },
    report: reportBody(report, label),
  };
}

// The texts to deliver for a finished run: [{ name, to, target, text }]. A
// node without a complete-triggered edge, or of an unknown kind, yields nothing.
function renderReports({ graph, worker, source, report, timedOut }) {
  if (!kindOfNode(graph, worker.node)) return [];
  const values = reportValues({ graph, worker, source, report, timedOut });
  const out = [];
  for (const { name, interaction, to } of completeInteractions(graph, worker.node)) {
    const text = render(interaction.body, values);
    if (text.length > 0) out.push({ name, to, target: interaction.target, text });
  }
  return out;
}

module.exports = { completeInteractions, kindOfNode, outcomeOf, reportValues, renderReports };
