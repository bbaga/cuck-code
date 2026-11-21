"use strict";

// Routing of finished runs in a choreographed pipeline (pure: no input or output, no server).
// The router asks routeCompletion what to do when one run ends, and resolveStage when the last
// checker of a stage ends. The runtime that acts on the answers is a later part.

const { completeInteractions } = require("./report-interaction");

const OUTCOMES = ["done", "pass", "reject", "missing", "timeout", "failed", "stopped"];
const DEFAULT_MAX_ROUNDS = 3;
const BROKEN = ["failed", "timeout", "stopped"];
const REJECTED = ["reject", "missing"];

const isRework = (it) => it.effect === "deliver" && it.target === "source";
const isReport = (it) => it.effect === "deliver" && it.target === "starter";

// The rework limit of a node: its maxRounds, or 3.
function maxRoundsOf(graph, nodeId) {
  const node = graph && graph.nodes ? graph.nodes[nodeId] : undefined;
  return node && Number.isInteger(node.maxRounds) ? node.maxRounds : DEFAULT_MAX_ROUNDS;
}

function kindOf(interaction) {
  if (interaction.effect === "create") return "handoff";
  if (interaction.effect === "arrive") return "arrive";
  if (isRework(interaction)) return "rework";
  if (isReport(interaction)) return "report";
  return null;
}

// The actions for one finished run: { actions: [{ kind, name, interaction, to }], exhausted }.
// kind is "handoff", "rework", "report" or "arrive". Fallback interactions apply only when no other
// interaction matches. `exhausted` is true when the rework limit removed a rework action.
function routeCompletion({ graph, worker, outcome, reworkRounds = 0 }) {
  if (!OUTCOMES.includes(outcome)) throw new Error(`unknown outcome '${outcome}'`);
  let exhausted = false;
  const kept = [];
  for (const item of completeInteractions(graph, worker.node)) {
    const when = Array.isArray(item.interaction.when) ? item.interaction.when : OUTCOMES;
    if (!when.includes(outcome)) continue;
    if (isRework(item.interaction) && reworkRounds >= maxRoundsOf(graph, worker.node)) {
      exhausted = true;
      continue;
    }
    kept.push(item);
  }
  const primary = kept.filter((item) => item.interaction.fallback !== true);
  const chosen = primary.length > 0 ? primary : kept.filter((item) => item.interaction.fallback === true);
  const actions = chosen
    .map((item) => ({ kind: kindOf(item.interaction), name: item.name, interaction: item.interaction, to: item.to }))
    .filter((a) => a.kind !== null);
  return { actions, exhausted };
}

// The checkers that the router starts together after `senderNode`: the targets of its
// complete-create edges, in edge order.
function stageOf(graph, senderNode) {
  const out = [];
  for (const item of completeInteractions(graph, senderNode)) {
    if (item.interaction.effect === "create" && !out.includes(item.to)) out.push(item.to);
  }
  return out;
}

// The first target of a complete interaction of `nodeId` that passes `test`, or null.
function firstTarget(graph, nodeId, test) {
  const found = completeInteractions(graph, nodeId).find((item) => test(item.interaction));
  return found ? found.to : null;
}

// The step after a stage in which every member passed: handoff, arrive, or a report as fallback.
// All members must give the same targets; else there is no common step.
function commonNextStep(graph, members, reworkRounds) {
  const steps = members.map((node) => {
    const { actions } = routeCompletion({ graph, worker: { node }, outcome: "pass", reworkRounds });
    return actions.filter((a) => a.kind === "handoff" || a.kind === "arrive");
  });
  const signature = (list) => JSON.stringify(list.map((a) => [a.kind, a.to]));
  const first = steps[0];
  if (first.length === 0 || steps.some((s) => signature(s) !== signature(first))) return null;
  return first;
}

// The result of resolveStage:
//   { kind: "rework"|"report"|"handoff"|"arrive",
//     to,         // node id of the target: the implementor node, the starter node, or the next node
//     targets,    // all target node ids (more than one only for a handoff)
//     exhausted,  // true when the rework limit stopped the automatic rework
//     rejecting,  // nodes of the members that rejected
//     passing }   // nodes of the members that passed
// `stage` is { sender, headRun, members: { <node>: { status, checkerId, outcome } } }.
// `reworkRounds` is { <sender node>: number }. Call this one time, after the last member ended.
function resolveStage({ graph, stage, reworkRounds = {} }) {
  const nodes = Object.keys(stage.members || {});
  if (nodes.length === 0) throw new Error("a stage needs at least one member");
  const outcomeOf = (node) => stage.members[node].outcome;
  for (const node of nodes) {
    if (!OUTCOMES.includes(outcomeOf(node))) throw new Error(`member '${node}': unknown outcome '${outcomeOf(node)}'`);
  }
  const rejecting = nodes.filter((n) => REJECTED.includes(outcomeOf(n)));
  const passing = nodes.filter((n) => outcomeOf(n) === "pass" || outcomeOf(n) === "done");
  const rounds = reworkRounds[stage.sender] || 0;
  const report = (exhausted, node) => {
    const to = firstTarget(graph, node, isReport);
    return { kind: "report", to, targets: to ? [to] : [], exhausted, rejecting, passing };
  };

  const broken = nodes.find((n) => BROKEN.includes(outcomeOf(n)));
  if (broken) return report(false, broken);

  if (rejecting.length > 0) {
    const reworkTargets = rejecting.map((n) => firstTarget(graph, n, isRework));
    if (reworkTargets.every((t) => t !== null)) {
      const limit = Math.min(...rejecting.map((n) => maxRoundsOf(graph, n)));
      if (rounds < limit) {
        return { kind: "rework", to: reworkTargets[0], targets: [reworkTargets[0]], exhausted: false, rejecting, passing };
      }
      return report(true, rejecting[0]);
    }
    return report(false, rejecting[0]);
  }

  const next = commonNextStep(graph, nodes, reworkRounds);
  if (!next) return report(false, nodes[0]);
  const targets = [...new Set(next.map((a) => a.to))];
  return { kind: next[0].kind, to: targets[0], targets, exhausted: false, rejecting, passing };
}

// Text builders. They get texts that are already rendered and read no file.

// One request for the head run: the rendered rework body of each rejecting member.
// `bodies` is a list of texts. `total` is the number of members. `passing` is a list of node ids.
function combinedReworkText({ total, bodies, passing }) {
  const passed = passing.length > 0 ? passing.join(", ") : "none";
  return [
    `REWORK REQUEST - ${bodies.length} of ${total} checkers rejected your latest run.`,
    ...bodies,
    `Checkers that passed: ${passed}.`,
  ].join("\n\n");
}

// One report for the planner: the rendered report of each member, in edge order.
// `members` is a list of { passed: boolean, text }.
function combinedReportText({ headName, sender, members }) {
  const pass = members.filter((m) => m.passed).length;
  return [
    `STAGE REPORT - '${headName}' after '${sender}': ${members.length} checkers, ${pass} PASS, ${members.length - pass} FAIL.`,
    ...members.map((m) => m.text),
  ].join("\n\n");
}

function reworkLimitText({ sender, headName, rounds }) {
  return `REWORK LIMIT REACHED - the checkers after '${sender}' rejected '${headName}' ${rounds} times. ` +
    "The router stopped the automatic rework.";
}

module.exports = { routeCompletion, maxRoundsOf, stageOf, resolveStage,
  combinedReworkText, combinedReportText, reworkLimitText, OUTCOMES, DEFAULT_MAX_ROUNDS };
