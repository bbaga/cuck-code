"use strict";

// The runtime of choreographed pipelines: handoff, rework and stages (the wait node is a later part).
// The server gives its helpers as parameters, so this module holds no server state.
// The router calls routeCompleted when a run ends. The decisions come from choreography.js.

const { outcomeOf, renderReports } = require("./report-interaction");
const { routeCompletion, stageOf, resolveStage, combinedReworkText, combinedReportText,
  reworkLimitText } = require("./choreography");
const { chainFieldNames } = require("./call-fields");

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// The start-call values that the nodes after `nodeId` need, kept on the chain head.
function pickChainFields(graph, nodeId, body) {
  const out = {};
  for (const name of chainFieldNames(graph, nodeId)) if (body[name] !== undefined) out[name] = body[name];
  return out;
}

// The chain state of a head as saved in line.json, and its restore.
function serializeChain(worker) {
  return { chainFields: worker.chainFields || {}, reworkRounds: worker.reworkRounds || {}, stage: worker.stage || null };
}

function restoreChain(saved) {
  return { chainFields: isObject(saved.chainFields) ? saved.chainFields : {},
    reworkRounds: isObject(saved.reworkRounds) ? saved.reworkRounds : {},
    stage: isObject(saved.stage) && isObject(saved.stage.members) ? saved.stage : null };
}

function restorePendingHandoffs(list) {
  return (Array.isArray(list) ? list : []).filter((e) => e && typeof e.to === "string"
    && typeof e.headId === "string" && Number.isInteger(e.headRun));
}

// The text of one rendered interaction of a run: kind "report" goes to the starter, "rework" to the source.
function renderKind(line, worker, head, kind, timedOut) {
  const target = kind === "rework" ? "source" : "starter";
  const items = renderReports({ graph: line.graph, worker, source: head, report: worker.lastRunText || "", timedOut });
  const item = items.find((i) => i.target === target);
  return item ? item.text : "";
}

function createChainRuntime(deps) {
  const { saveLine, slog, runningCount, workerCap, afterGate, createSourceChecker, sourceIdentity,
    reportForValidation, deliverToInstance, enqueueRequest, interactionReportRequest } = deps;
  const tell = (line, text) => enqueueRequest(line, interactionReportRequest(text));
  const isHeadNode = (graph, node) => graph.types[graph.nodes[node].type].workspace === "own-worktree";
  const headOf = (line, worker) => (isHeadNode(line.graph, worker.node) ? worker : line.workers.get(worker.validates) || null);

  // A handoff that cannot go on ends the chain: the planner gets one message.
  function handoffFailed(line, head, toNode, error) {
    slog("warn", "handoff.failed", { lineId: line.id, headId: head.id, node: toNode, error });
    head.stage = null;
    saveLine(line);
    const fallback = renderKind(line, head, null, "report", false);
    tell(line, [`HANDOFF FAILED - ${toNode} could not start for '${head.name}': ${error}`, fallback]
      .filter(Boolean).join("\n\n"));
  }

  // Starts one checker of a stage. A full worker cap queues the handoff in line.pendingHandoffs.
  function autoStartChecker(line, toNode, head) {
    const member = head.stage && head.stage.members[toNode];
    const gate = afterGate(line.workers.values(), line.graph, toNode, head);
    if (!gate.ok) return handoffFailed(line, head, toNode, "AFTER_NOT_PASSED: the nodes in 'after' have no PASS on the latest run");
    const identity = sourceIdentity({ workerId: head.id, invocationId: head.lastCompletedInvocationId,
      runId: head.runGeneration, report: head.lastRunText || "" });
    if (!identity) return handoffFailed(line, head, toNode, "the head has no completed run");
    const extra = {};
    for (const key of Object.keys(line.graph.nodes[toNode].fields || {})) {
      if (head.chainFields && head.chainFields[key] !== undefined) extra[key] = head.chainFields[key];
    }
    let out;
    try {
      out = createSourceChecker(line, toNode, head, { source: { ...identity, auto: true },
        criteria: head.chainFields && head.chainFields.criteria, extra, afterChecks: gate.passed,
        report: reportForValidation(null, head.lastRunText) });
    } catch (error) {
      out = { ok: false, code: "START_ERROR", error: error.message };
    }
    if (out.ok) {
      // The run may have ended already: keep a "done" member as it is.
      if (member && member.status === "queued") member.status = "running";
      if (member) member.checkerId = out.worker.id;
      return out.worker;
    }
    if (out.code === "WORKER_CAP") {
      if (!Array.isArray(line.pendingHandoffs)) line.pendingHandoffs = [];
      line.pendingHandoffs.push({ to: toNode, headId: head.id, headRun: head.runGeneration });
      saveLine(line);
      return null;
    }
    return handoffFailed(line, head, toNode, `${out.code ? `${out.code}: ` : ""}${out.error}`);
  }

  // Starts the stage after `senderNode`: one checker for each complete-create edge target.
  function startStage(line, head, senderNode) {
    const nodes = stageOf(line.graph, senderNode);
    const stage = { sender: senderNode, headRun: head.runGeneration, members: {} };
    for (const node of nodes) stage.members[node] = { status: "queued", checkerId: null, outcome: null };
    head.stage = stage;
    saveLine(line);
    for (const node of nodes) {
      if (head.stage !== stage) break;
      autoStartChecker(line, node, head);
    }
  }

  // Starts the queued handoffs while the worker cap has free slots. Drops the stale ones.
  function drainPendingHandoffs(line) {
    const pending = Array.isArray(line.pendingHandoffs) ? line.pendingHandoffs : [];
    const kept = [];
    const startable = [];
    for (const entry of pending) {
      const head = line.workers.get(entry.headId);
      const live = head && head.runGeneration === entry.headRun && head.stage
        && head.stage.headRun === entry.headRun && head.stage.members[entry.to]
        && head.stage.members[entry.to].status === "queued";
      if (live) (runningCount(line) + startable.length < workerCap ? startable : kept).push(entry);
    }
    if (startable.length === 0 && kept.length === pending.length) return;
    line.pendingHandoffs = kept;
    saveLine(line);
    for (const entry of startable) {
      const head = line.workers.get(entry.headId);
      if (head.stage && head.stage.headRun === entry.headRun) autoStartChecker(line, entry.to, head);
    }
  }

  // After a restart a running member never ends: the chain stops and the planner decides.
  function recoverAfterLoad(line) {
    for (const head of line.workers.values()) {
      const lost = head.stage && Object.entries(head.stage.members).find(([, m]) => m.status === "running");
      if (!lost) continue;
      handoffFailed(line, head, lost[0], "the router restarted while this checker was running");
    }
    drainPendingHandoffs(line);
  }

  // The members that a stage decision reports: one text for one member, else a combined text.
  function reportText(line, head, stage, nodes) {
    const texts = nodes.map((node) => {
      const m = stage.members[node];
      const checker = line.workers.get(m.checkerId);
      const text = checker ? renderKind(line, checker, head, "report", m.outcome === "timeout") : "";
      return { passed: m.outcome === "pass" || m.outcome === "done",
        text: text || `Checker '${node}' ended with outcome '${m.outcome}'.` };
    });
    return texts.length === 1 ? texts[0].text
      : combinedReportText({ headName: head.name, sender: stage.sender, members: texts });
  }

  function decideStage(line, head, stage) {
    const decision = resolveStage({ graph: line.graph, stage, reworkRounds: head.reworkRounds });
    const nodes = Object.keys(stage.members);
    const rounds = head.reworkRounds[stage.sender] || 0;
    head.stage = null;
    if (decision.kind === "rework") {
      head.reworkRounds[stage.sender] = rounds + 1;
      const bodies = decision.rejecting.map((node) => {
        const m = stage.members[node];
        return renderKind(line, line.workers.get(m.checkerId), head, "rework", m.outcome === "timeout");
      });
      const text = nodes.length === 1 ? bodies[0]
        : combinedReworkText({ total: nodes.length, bodies, passing: decision.passing });
      const sent = deliverToInstance(line, head, text);
      if (!sent.ok) {
        tell(line, `REWORK BLOCKED - ${sent.error}\n\n${reportText(line, head, stage, nodes)}`);
      }
    } else if (decision.kind === "handoff") {
      startStage(line, head, nodes[0]);
    } else {
      // A report, or an arrive (the wait node runtime is a later part: the planner gets the report).
      const text = reportText(line, head, stage, nodes);
      tell(line, decision.exhausted
        ? `${reworkLimitText({ sender: stage.sender, headName: head.name, rounds })}\n\n${text}` : text);
    }
    saveLine(line);
  }

  // A checker of a stage ended.
  function stageMemberClosed(line, worker, timedOut) {
    const head = line.workers.get(worker.validates);
    const stage = head && head.stage;
    const member = stage && stage.members[worker.node];
    if (!member || stage.headRun !== head.runGeneration || stage.headRun !== worker.validationSource.runId
      || member.status === "done") {
      slog("info", "stage.result.stale", { lineId: line.id, workerId: worker.id });
      return;
    }
    member.status = "done";
    member.checkerId = worker.id;
    member.outcome = outcomeOf(line.graph, worker, timedOut);
    saveLine(line);
    if (Object.values(stage.members).every((m) => m.status === "done")) decideStage(line, head, stage);
  }

  // A run ended in a graph pipeline: do the actions of its node.
  function routeCompleted(line, worker, { timedOut }) {
    if (worker.validationSource && worker.validationSource.auto === true) return stageMemberClosed(line, worker, timedOut);
    const head = headOf(line, worker);
    const outcome = outcomeOf(line.graph, worker, timedOut);
    const { actions } = routeCompletion({ graph: line.graph, worker, outcome });
    if (actions.some((a) => a.kind === "handoff")) {
      if (head) return startStage(line, head, worker.node);
      return handoffFailed(line, worker, worker.node, "the chain head is missing");
    }
    // A rework or arrive action of a run outside a stage has no runtime: the planner gets the report.
    const text = renderKind(line, worker, head, "report", timedOut);
    if (text && actions.length > 0) tell(line, text);
  }

  return { routeCompleted, drainPendingHandoffs, recoverAfterLoad };
}

// The feedback of the planner starts the chain again from the head.
function resetChain(worker) {
  worker.reworkRounds = {};
  worker.stage = null;
}

module.exports = { createChainRuntime, pickChainFields, serializeChain, restoreChain,
  restorePendingHandoffs, resetChain };
