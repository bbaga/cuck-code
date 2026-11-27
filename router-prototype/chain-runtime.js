"use strict";

// The runtime of choreographed pipelines: handoff, rework, stages and the arrival at a wait node.
// The server gives its helpers as parameters, so this module holds no server state.
// The router calls routeCompleted when a run ends. The decisions come from choreography.js.

const { outcomeOf, renderReports } = require("./report-interaction");
const { routeCompletion, stageOf, resolveStage, checkerReason, combinedReworkText, indeterminateText, combinedReportText,
  reworkLimitText, maxRoundsOf } = require("./choreography");
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
  return { chainFields: worker.chainFields || {}, reworkRounds: worker.reworkRounds || {}, stage: worker.stage || null,
    pendingArrival: worker.pendingArrival || null };
}

function restoreChain(saved) {
  return { chainFields: isObject(saved.chainFields) ? saved.chainFields : {},
    reworkRounds: isObject(saved.reworkRounds) ? saved.reworkRounds : {},
    stage: isObject(saved.stage) && isObject(saved.stage.members) ? saved.stage : null,
    pendingArrival: isObject(saved.pendingArrival) && typeof saved.pendingArrival.node === "string"
      ? saved.pendingArrival : null };
}

// What the dashboard shows for a chain head: the rework counts, the limit of the next stage and the stage.
function chainDashboardFields(graph, worker) {
  const node = graph && graph.nodes && graph.nodes[worker.node];
  if (!node || graph.types[node.type].workspace !== "own-worktree") return {};
  const members = stageOf(graph, worker.node);
  const stage = worker.stage ? { sender: worker.stage.sender,
    members: Object.entries(worker.stage.members).map(([name, m]) => ({ node: name, status: m.status,
      outcome: m.outcome, checkerId: m.checkerId })) } : null;
  return { reworkRounds: worker.reworkRounds || {},
    maxRounds: members.length > 0 ? { [worker.node]: Math.min(...members.map((n) => maxRoundsOf(graph, n))) } : {},
    stage };
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
    reportForValidation, deliverToInstance, enqueueRequest, interactionReportRequest, wait, broadcast } = deps;
  const tell = (line, text) => enqueueRequest(line, interactionReportRequest(text));
  const isHeadNode = (graph, node) => graph.types[graph.nodes[node].type].workspace === "own-worktree";
  const headOf = (line, worker) => (isHeadNode(line.graph, worker.node) ? worker : line.workers.get(worker.validates) || null);

  // Tells the dashboard the current chain state of the head. Every change of head.stage calls it.
  function announce(line, head) {
    broadcast(line, "worker_status", { workerId: head.id, status: head.status, verdict: head.verdict || null,
      worker: { id: head.id, ...chainDashboardFields(line.graph, head) } });
  }

  // A handoff that cannot go on ends the chain: the planner gets one message.
  function handoffFailed(line, head, toNode, error) {
    slog("warn", "handoff.failed", { lineId: line.id, headId: head.id, node: toNode, error });
    head.stage = null;
    saveLine(line);
    announce(line, head);
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
      announce(line, head);
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
    announce(line, head);
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
      const live = entry.wait ? wait.handoffLive(line, entry) : head && head.runGeneration === entry.headRun && head.stage
        && head.stage.headRun === entry.headRun && head.stage.members[entry.to]
        && head.stage.members[entry.to].status === "queued";
      if (live) (runningCount(line) + startable.length < workerCap ? startable : kept).push(entry);
    }
    if (startable.length === 0 && kept.length === pending.length) return;
    line.pendingHandoffs = kept;
    saveLine(line);
    for (const entry of startable) {
      const head = line.workers.get(entry.headId);
      if (entry.wait) wait.retryHandoff(line, entry);
      else if (head.stage && head.stage.headRun === entry.headRun) autoStartChecker(line, entry.to, head);
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

  // The head passed: the wait instance of `node` records it. Without a wait instance the head keeps a
  // pending arrival and the planner gets the fallback report. A later wait instance imports the arrival.
  function arrive(line, head, node, checker, fallbackText) {
    if (wait.arrive(line, head, node, checker)) return;
    head.pendingArrival = { node, runGeneration: head.runGeneration, checkerId: checker.id };
    saveLine(line);
    tell(line, fallbackText);
  }

  // The named members of a stage decision, in the order of the stage members.
  function stageMembers(line, head, stage, wanted, withBody) {
    return Object.keys(stage.members).filter((node) => wanted.includes(node)).map((node) => {
      const m = stage.members[node];
      const checker = line.workers.get(m.checkerId);
      const reason = checkerReason({ outcome: m.outcome, report: checker ? checker.lastRunText : "" });
      const body = withBody && reason === "fail"
        ? renderKind(line, checker, head, "rework", m.outcome === "timeout") : "";
      return { node, name: checker ? checker.name : node, reason, body };
    });
  }

  function decideStage(line, head, stage) {
    const decision = resolveStage({ graph: line.graph, stage, reworkRounds: head.reworkRounds });
    const nodes = Object.keys(stage.members);
    const rounds = head.reworkRounds[stage.sender] || 0;
    head.stage = null;
    if (decision.kind === "rework") {
      head.reworkRounds[stage.sender] = rounds + 1;
      const members = stageMembers(line, head, stage, [...decision.rejecting, ...decision.indeterminate], true);
      const text = members.length === 1 && members[0].reason === "fail" && nodes.length === 1
        ? members[0].body
        : combinedReworkText({ total: nodes.length, members, passing: decision.passing });
      const sent = deliverToInstance(line, head, text);
      if (!sent.ok) {
        tell(line, `REWORK BLOCKED - ${sent.error}\n\n${reportText(line, head, stage, nodes)}`);
      }
    } else if (decision.kind === "handoff") {
      startStage(line, head, nodes[0]);
    } else {
      let text = reportText(line, head, stage, nodes);
      const open = Object.values(stage.members).some((m) => ["failed", "timeout", "stopped"].includes(m.outcome));
      if (decision.kind === "report" && decision.indeterminate.length > 0
        && decision.rejecting.length === 0 && !open) {
        const members = stageMembers(line, head, stage, decision.indeterminate, false);
        text = `${indeterminateText({ headName: head.name, sender: stage.sender, members })}\n\n${text}`;
      }
      if (decision.kind === "arrive") {
        arrive(line, head, decision.to, line.workers.get(stage.members[nodes[0]].checkerId), text);
      } else {
        tell(line, decision.exhausted
          ? `${reworkLimitText({ sender: stage.sender, headName: head.name, rounds })}\n\n${text}` : text);
      }
    }
    saveLine(line);
    announce(line, head);
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
    announce(line, head);
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
    const text = renderKind(line, worker, head, "report", timedOut);
    const arrival = actions.find((a) => a.kind === "arrive");
    if (arrival && head) return arrive(line, head, arrival.to, worker, text);
    // A rework action of a run outside a stage has no runtime: the planner gets the report.
    if (text && actions.length > 0) tell(line, text);
  }

  // The feedback of the planner starts the chain again from the head: the stage clears.
  function clearChain(line, head) {
    resetChain(head);
    announce(line, head);
  }

  return { routeCompleted, drainPendingHandoffs, recoverAfterLoad, clearChain };
}

// The feedback of the planner starts the chain again from the head.
function resetChain(worker) {
  worker.reworkRounds = {};
  worker.stage = null;
}

module.exports = { createChainRuntime, pickChainFields, serializeChain, restoreChain,
  restorePendingHandoffs, resetChain, chainDashboardFields };
