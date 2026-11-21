"use strict";

// The runtime of the wait node: one wait worker for each batch. It has no process, no worktree and no branch.
// The server gives its helpers as parameters, so this module holds no server state except the timers.
// A head that passed its checkers arrives (arrive). When every member has arrived, the wait worker
// completes and the router routes its completion: a handoff to the next node, or a report to the planner.

const crypto = require("node:crypto");
const { routeCompletion } = require("./choreography");
const { chainFieldNames } = require("./call-fields");
const { splitInstances } = require("./fields");
const { recordArrival, isReady, memberStates, batchReportText, missingReportText } = require("./wait-node");

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// The worker of a line with this id, else the one with this name. Returns undefined when none matches.
function findWorker(workers, ref) {
  if (workers.has(ref)) return workers.get(ref);
  return [...workers.values()].find((w) => w.name === ref);
}

// The wait worker as saved in line.json, and its restore. A running wait worker stays running.
function serializeWait(worker) {
  return { members: worker.members, arrivals: worker.arrivals, startedAt: worker.startedAt,
    outcome: worker.outcome || null };
}

function restoreWait(saved, lineId) {
  return { id: saved.id, lineId, name: saved.name, node: saved.node, runner: "wait", role: "wait", kind: "wait",
    members: (Array.isArray(saved.members) ? saved.members : []).filter((id) => typeof id === "string"),
    arrivals: isObject(saved.arrivals) ? saved.arrivals : {},
    chainFields: isObject(saved.chainFields) ? saved.chainFields : {},
    status: ["running", "completed", "failed", "stopped"].includes(saved.status) ? saved.status : "stopped",
    verdict: saved.verdict || null, outcome: saved.outcome || null, lastRunText: saved.lastRunText || "",
    runGeneration: 1, startedAt: typeof saved.startedAt === "string" ? saved.startedAt : new Date().toISOString(),
    stopRequested: false, child: null, transcript: [] };
}

function createWaitRuntime(deps) {
  const { saveLine, slog, broadcast, runningCount, workerCap, resolveNodeSettings, createIntegration,
    tell } = deps;
  const timers = new Map();

  const runningWaits = (line, node) => [...line.workers.values()]
    .filter((w) => w.runner === "wait" && w.status === "running" && (node === undefined || w.node === node));

  function clearTimer(wait) {
    clearTimeout(timers.get(wait.id));
    timers.delete(wait.id);
  }

  const notify = (line, wait) => broadcast(line, "wait_update",
    { workerId: wait.id, members: memberStates(wait, line.workers) });

  // The batch ended without all members: the planner gets one report with the missing members.
  function endUnready(line, wait, status, outcome, reason) {
    if (wait.status !== "running") return;
    clearTimer(wait);
    wait.status = status;
    wait.outcome = outcome;
    wait.lastRunText = missingReportText(wait, line.workers, reason);
    saveLine(line);
    broadcast(line, "worker_status", { workerId: wait.id, status, verdict: null, outcome, runner: "wait",
      members: memberStates(wait, line.workers) });
    slog("info", "wait.ended", { lineId: line.id, workerId: wait.id, outcome });
    tell(line, wait.lastRunText);
  }

  // Sets the timer of the time limit with the rest of the time. A wait node without limit has no timer.
  // An expired limit applies at once.
  function armTimer(line, wait) {
    clearTimer(wait);
    const limit = resolveNodeSettings(line, wait.node).timeLimit;
    if (limit === null || limit === undefined) return;
    const rest = Date.parse(wait.startedAt) + limit * 1000 - Date.now();
    if (rest <= 0) return endUnready(line, wait, "failed", "timeout", "time limit reached");
    const timer = setTimeout(() => endUnready(line, wait, "failed", "timeout", "time limit reached"), rest);
    if (timer.unref) timer.unref();
    timers.set(wait.id, timer);
  }

  // Starts the next node after a completed batch. A full worker cap queues the handoff.
  function startHandoff(line, wait, toNode) {
    const fail = (error) => {
      slog("warn", "wait.handoff.failed", { lineId: line.id, node: toNode, error });
      tell(line, `HANDOFF FAILED - ${toNode} could not start for '${wait.name}': ${error}\n\n${wait.lastRunText}`);
    };
    const node = line.graph.nodes[toNode];
    if (line.graph.types[node.type].workspace !== "integration") {
      return fail(`the node '${toNode}' cannot start from a wait node`);
    }
    if (runningCount(line) >= workerCap) {
      if (!Array.isArray(line.pendingHandoffs)) line.pendingHandoffs = [];
      line.pendingHandoffs.push({ to: toNode, headId: wait.id, headRun: wait.runGeneration, wait: true });
      saveLine(line);
      return;
    }
    const extra = {};
    for (const key of Object.keys(node.fields || {})) {
      if (wait.chainFields[key] !== undefined) extra[key] = wait.chainFields[key];
    }
    let out;
    try {
      out = createIntegration(line, toNode, { instructions: wait.chainFields.instructions, extra });
    } catch (error) {
      out = { ok: false, error: error.message };
    }
    if (!out.ok) fail(`${out.code ? `${out.code}: ` : ""}${out.error}`);
  }

  // A queued handoff of a wait worker is live while the worker is completed.
  const handoffLive = (line, entry) => {
    const wait = line.workers.get(entry.headId);
    return !!wait && wait.runner === "wait" && wait.status === "completed";
  };

  function retryHandoff(line, entry) {
    startHandoff(line, line.workers.get(entry.headId), entry.to);
  }

  // Completes the wait worker when every member has a valid arrival.
  function checkReady(line, wait) {
    if (wait.status !== "running" || !isReady(wait, line.workers)) return;
    clearTimer(wait);
    wait.status = "completed";
    wait.verdict = "pass";
    wait.outcome = "pass";
    wait.lastRunText = batchReportText(wait, line.workers);
    saveLine(line);
    broadcast(line, "worker_status", { workerId: wait.id, status: "completed", verdict: "pass", outcome: "pass",
      runner: "wait", members: memberStates(wait, line.workers) });
    slog("info", "wait.completed", { lineId: line.id, workerId: wait.id });
    const { actions } = routeCompletion({ graph: line.graph, worker: wait, outcome: "pass" });
    const handoff = actions.find((a) => a.kind === "handoff");
    if (handoff) return startHandoff(line, wait, handoff.to);
    if (actions.some((a) => a.kind === "report")) tell(line, wait.lastRunText);
  }

  const checkAll = (line) => runningWaits(line).forEach((wait) => checkReady(line, wait));

  // The head `head` passed its checkers and arrives at wait node `node`.
  // Returns false when no running wait instance of this node has the head as member.
  function arrive(line, head, node, checker) {
    const wait = runningWaits(line, node).find((w) => w.members.includes(head.id));
    if (!wait) return false;
    recordArrival(wait, head, checker, Date.now());
    saveLine(line);
    notify(line, wait);
    checkReady(line, wait);
    return true;
  }

  // A member run started: an earlier arrival of this head is now stale.
  function memberRunStarted(line, head) {
    for (const wait of runningWaits(line)) if (wait.members.includes(head.id)) notify(line, wait);
  }

  // Returns { ok: true, worker, response } or { ok: false, status, error, code? }.
  function createWaitInstance(line, nodeId, body) {
    const fail = (status, error, code) => ({ ok: false, status, error, ...(code ? { code } : {}) });
    const members = [];
    for (const ref of splitInstances(body.members)) {
      const member = findWorker(line.workers, ref);
      if (!member) return fail(404, `no such instance: '${ref}'`);
      if (!members.includes(member)) members.push(member);
    }
    for (const other of runningWaits(line, nodeId)) {
      const clash = members.find((m) => other.members.includes(m.id));
      if (clash) {
        return fail(409, `'${clash.name}' is already a member of the running wait instance '${other.name}'`,
          "MEMBER_IN_BATCH");
      }
    }
    let name = body.name;
    if (!name) {
      let n = 1;
      while ([...line.workers.values()].some((w) => w.name === `${nodeId}-${n}`)) n++;
      name = `${nodeId}-${n}`;
    } else if ([...line.workers.values()].some((w) => w.name === name)) {
      return fail(409, `worker '${name}' already exists`);
    }
    const chainFields = {};
    for (const key of chainFieldNames(line.graph, nodeId)) if (body[key] !== undefined) chainFields[key] = body[key];
    const wait = { id: crypto.randomUUID(), lineId: line.id, name, node: nodeId, runner: "wait", role: "wait",
      kind: "wait", members: members.map((m) => m.id), arrivals: {}, chainFields, status: "running",
      verdict: null, outcome: null, lastRunText: "", runGeneration: 1, startedAt: new Date().toISOString(),
      stopRequested: false, child: null, transcript: [] };
    // An arrival that came before this instance existed counts when it is for the current run.
    for (const member of members) {
      const pending = member.pendingArrival;
      if (pending && pending.node === nodeId && pending.runGeneration === member.runGeneration) {
        recordArrival(wait, member, { id: pending.checkerId }, Date.now());
        member.pendingArrival = null;
      }
    }
    line.workers.set(wait.id, wait);
    if (!saveLine(line)) {
      line.workers.delete(wait.id);
      return fail(500, "could not save the wait instance");
    }
    slog("info", "wait.spawned", { lineId: line.id, workerId: wait.id, members: wait.members });
    broadcast(line, "worker_spawned", { worker: { id: wait.id, name, status: wait.status, role: wait.role,
      node: nodeId, kind: "wait", runner: "wait", members: memberStates(wait, line.workers) } });
    armTimer(line, wait);
    checkReady(line, wait);
    return { ok: true, worker: wait, response: { workerId: wait.id, name, members: wait.members } };
  }

  // The stop route: the planner gets the report with the missing members.
  const stop = (line, wait) => endUnready(line, wait, "stopped", "stopped", "stopped");

  // After a restart a running wait worker stays running: it gets its timer again and a readiness check.
  function recoverAfterLoad(line) {
    for (const wait of runningWaits(line)) {
      armTimer(line, wait);
      checkReady(line, wait);
    }
  }

  return { createWaitInstance, arrive, memberRunStarted, checkAll, stop, recoverAfterLoad,
    handoffLive, retryHandoff, hasTimer: (id) => timers.has(id) };
}

module.exports = { createWaitRuntime, findWorker, serializeWait, restoreWait };
