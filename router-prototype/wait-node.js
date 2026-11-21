"use strict";

// The state of one wait instance (pure: no input or output, no server).
// A wait worker has { node, name, members: [head ids], arrivals: { <head id>: { runGeneration, checkerId, at } } }.
// `workers` is the Map of the line workers (id -> worker).

// Records that `head` arrived with the PASS of `checker`. This mutates wait.arrivals in place
// and returns it. An older arrival of the same head is replaced.
function recordArrival(wait, head, checker, now) {
  if (!wait.arrivals || typeof wait.arrivals !== "object") wait.arrivals = {};
  wait.arrivals[head.id] = { runGeneration: head.runGeneration, checkerId: checker.id, at: now };
  return wait.arrivals;
}

// The state of one member: "arrived" (the arrival is for the current run), "stale" (an arrival
// of an older run) or "waiting" (no arrival).
function stateOf(wait, member) {
  const arrival = wait.arrivals && wait.arrivals[member.id];
  if (!arrival) return "waiting";
  return member.worker && arrival.runGeneration === member.worker.runGeneration ? "arrived" : "stale";
}

function membersOf(wait, workers) {
  return wait.members.map((id) => ({ id, worker: workers.get(id) || null }));
}

// [{ id, name, state }] in member order. A removed member keeps its id as name.
function memberStates(wait, workers) {
  return membersOf(wait, workers).map((m) => ({ id: m.id, name: m.worker ? m.worker.name : m.id,
    state: stateOf(wait, m) }));
}

// True when every member has a valid arrival and no member runs. A removed member is not ready.
function isReady(wait, workers) {
  return membersOf(wait, workers).every((m) => m.worker !== null && m.worker.status !== "running"
    && stateOf(wait, m) === "arrived");
}

const title = (wait) => `BATCH REPORT - wait node '${wait.node}' instance '${wait.name}'`;

// The report of a batch in which every member passed. Each line names the checker of the arrival.
function batchReportText(wait, workers) {
  const lines = membersOf(wait, workers).map((m) => {
    const checker = workers.get(wait.arrivals[m.id].checkerId);
    return `- ${m.worker.name} (id ${m.id}, branch ${m.worker.branch}): passed ${checker ? checker.name : wait.arrivals[m.id].checkerId}`;
  });
  return [`${title(wait)}: all ${wait.members.length} members passed.`, ...lines].join("\n");
}

// The report of a batch that ended without all members. `reason` is "time limit reached" or "stopped".
function missingReportText(wait, workers, reason) {
  const states = memberStates(wait, workers);
  const missing = states.filter((s) => s.state !== "arrived").length;
  const lines = states.map((s) => `- ${s.name} (id ${s.id}): ${s.state}`);
  return [`${title(wait)}: ${reason}. ${missing} of ${states.length} members did not arrive.`, ...lines].join("\n");
}

module.exports = { recordArrival, isReady, memberStates, batchReportText, missingReportText };
