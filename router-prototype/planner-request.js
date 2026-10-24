"use strict";

const { isSkipValidation } = require("./handoff");

function sourceIdentity({ workerId, invocationId, runId, report }) {
  if (typeof workerId !== "string" || !workerId
    || typeof invocationId !== "string" || !invocationId
    || !Number.isInteger(runId) || typeof report !== "string") return null;
  return Object.freeze({ workerId, invocationId, runId, report });
}

function plannerRequest(text, source = null) {
  const identity = source ? sourceIdentity(source) : null;
  return Object.freeze({ text, source: identity });
}

function implementorReportRequest(text, worker, invocation, report) {
  return plannerRequest(text, {
    workerId: worker && worker.id,
    invocationId: invocation && invocation.invocationId,
    runId: invocation && invocation.runId,
    report,
  });
}

function restorePlannerRequest(value) {
  if (!value || typeof value.text !== "string") return null;
  return plannerRequest(value.text, value.source || null);
}

function completePlannerCriteria(request, criteria, {
  getWorker,
  onCriteria,
  onSkip = () => {},
  onMissing = () => {},
  onSuperseded = () => {},
  onIncompleteSource = () => {},
}) {
  const source = request && request.source;
  const trusted = source && sourceIdentity(source);
  if (!trusted) {
    onIncompleteSource(request || null);
    return { decision: "incomplete-source" };
  }
  const worker = getWorker(trusted.workerId);
  if (!worker || worker.status === "running"
    || worker.runGeneration !== trusted.runId
    || worker.lastCompletedInvocationId !== trusted.invocationId) {
    onSuperseded(trusted, worker || null);
    return { decision: "superseded", source: trusted };
  }
  if (typeof criteria !== "string" || !criteria.trim()) {
    onMissing(trusted, worker);
    return { decision: "missing-criteria", source: trusted };
  }
  if (isSkipValidation(criteria)) {
    onSkip(trusted, worker, criteria);
    return { decision: "skip-validation", source: trusted };
  }
  onCriteria(trusted, criteria, worker);
  return { decision: "criteria", source: trusted };
}

function retryPlannerRequest(queue, request) {
  const retry = restorePlannerRequest(request);
  if (!retry) return false;
  queue.unshift(retry);
  return true;
}

function serializePlannerRequests(requests) {
  return Array.isArray(requests)
    ? requests.map((request) => request && ({ text: request.text, source: request.source || null }))
    : [];
}

function restorePlannerRequests(requests) {
  return Array.isArray(requests)
    ? requests.map(restorePlannerRequest).filter(Boolean)
    : [];
}

module.exports = {
  sourceIdentity,
  plannerRequest,
  implementorReportRequest,
  restorePlannerRequest,
  completePlannerCriteria,
  retryPlannerRequest,
  serializePlannerRequests,
  restorePlannerRequests,
};
