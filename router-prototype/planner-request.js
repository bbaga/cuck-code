"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const NOTICE_ID_RE = /^[A-Za-z0-9:_.-]{1,128}$/;
const MAX_KNOWN_NOTICES = 500;
// Every request made by a report interaction (task C6) carries this flow marker.
const FLOW_INTERACTIONS = "interactions";

function validNoticeId(id) {
  return typeof id === "string" && NOTICE_ID_RE.test(id);
}

function sourceIdentity({ workerId, invocationId, runId, report }) {
  if (typeof workerId !== "string" || !workerId
    || typeof invocationId !== "string" || !invocationId
    || !Number.isInteger(runId) || typeof report !== "string") return null;
  return Object.freeze({ workerId, invocationId, runId, report });
}

function plannerRequest(text, noticeId = null, userText = null, recorded = false, id = null, flow = null) {
  const request = { id: typeof id === "string" && id ? id : crypto.randomUUID(), text };
  if (typeof userText === "string") {
    request.fromUser = true;
    request.userText = userText;
  }
  if (validNoticeId(noticeId)) request.noticeId = noticeId;
  if (recorded === true) request.recorded = true;
  if (flow === FLOW_INTERACTIONS) request.flow = flow;
  return Object.freeze(request);
}

function recordedPlannerRequest(request) {
  return plannerRequest(request.text, request.noticeId,
    request.fromUser ? request.userText : null, true, request.id, request.flow);
}

// A report request of the interactions flow.
function interactionReportRequest(text) {
  return plannerRequest(text, null, null, false, null, FLOW_INTERACTIONS);
}

function restorePlannerRequest(value) {
  if (!value || typeof value.text !== "string") return null;
  const userText = value.fromUser && typeof value.userText === "string" ? value.userText : null;
  return plannerRequest(value.text, value.noticeId, userText,
    value.recorded === true, value.id, value.flow);
}

function retryPlannerRequest(queue, request) {
  const retry = restorePlannerRequest(request);
  if (!retry) return false;
  queue.unshift(retry);
  return true;
}

function serializePlannerRequest(request) {
  const out = { id: request.id, text: request.text };
  if (validNoticeId(request.noticeId)) out.noticeId = request.noticeId;
  if (request.fromUser && typeof request.userText === "string") {
    out.fromUser = true;
    out.userText = request.userText;
  }
  if (request.recorded === true) out.recorded = true;
  if (request.flow === FLOW_INTERACTIONS) out.flow = request.flow;
  return out;
}

function serializePlannerRequests(requests) {
  return Array.isArray(requests)
    ? requests.map((request) => request && serializePlannerRequest(request))
    : [];
}

function restorePlannerRequests(requests) {
  return Array.isArray(requests)
    ? requests.map(restorePlannerRequest).filter(Boolean)
    : [];
}

function cancelQueuedUserPrompt(line, requestId) {
  if (!line || typeof requestId !== "string" || !requestId) return { status: "unknown" };
  if (line.activePlannerRequest && line.activePlannerRequest.id === requestId) {
    return { status: "active" };
  }
  const queue = Array.isArray(line.queue) ? line.queue : [];
  const index = queue.findIndex((request) => request && request.id === requestId);
  if (index < 0) return { status: "unknown" };
  if (queue[index].fromUser !== true) return { status: "internal" };
  const [request] = queue.splice(index, 1);
  return { status: "cancellable", request, index };
}

function queuedUserPromptProjection(requests) {
  let position = 0;
  return (Array.isArray(requests) ? requests : []).reduce((rows, request) => {
    if (request && request.fromUser === true) {
      rows.push({ id: request.id, text: request.userText || request.text, position: ++position });
    }
    return rows;
  }, []);
}

function restoreKnownNoticeIds(ids) {
  return Array.isArray(ids)
    ? ids.filter(validNoticeId).slice(-MAX_KNOWN_NOTICES)
    : [];
}

// Write a file durably: temp file in the same directory, fsync, rename.
function writeFileDurable(file, data, fsImpl = fs) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  let fd = null;
  try {
    fd = fsImpl.openSync(tmp, "w");
    fsImpl.writeFileSync(fd, data);
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = null;
    fsImpl.renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) { try { fsImpl.closeSync(fd); } catch {} }
    try { fsImpl.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// Queue a request. `save(line)` must return true only after a durable save.
// Returns { ok, duplicate } or { ok: false, reason }.
function enqueuePlannerRequest(line, request, save) {
  const trusted = restorePlannerRequest(request);
  if (!trusted) return { ok: false, reason: "invalid-request" };
  if (line.deleted) return { ok: false, reason: "line-deleted" };
  const id = trusted.noticeId;
  if (id) {
    const known = line.knownNoticeIds || (line.knownNoticeIds = []);
    if (known.includes(id) || line.queue.some((r) => r && r.noticeId === id)
      || (line.activePlannerRequest && line.activePlannerRequest.noticeId === id)) {
      return { ok: true, duplicate: true };
    }
  }
  const previousKnown = line.knownNoticeIds;
  line.queue.push(trusted);
  if (id) {
    line.knownNoticeIds = [...previousKnown, id].slice(-MAX_KNOWN_NOTICES);
  }
  let saved = false;
  try { saved = save(line) === true; } catch { saved = false; }
  if (!saved) {
    const index = line.queue.lastIndexOf(trusted);
    if (index >= 0) line.queue.splice(index, 1);
    if (id) line.knownNoticeIds = previousKnown;
    return { ok: false, reason: "save-failed" };
  }
  return { ok: true, duplicate: false };
}

// Queue a user prompt. Position and log come before pump, so an idle line
// reports the queue length the user saw before the pump took the request.
function submitPrompt(line, request, { wasStarted, save, pump, onQueued }) {
  const result = enqueuePlannerRequest(line, request, save);
  if (!result.ok) {
    line.started = wasStarted;
    const status = result.reason === "invalid-request" ? 400 : result.reason === "line-deleted" ? 410 : 500;
    return { status, body: { error: `could not save prompt: ${result.reason}` } };
  }
  const position = line.queue.length;
  if (onQueued) onQueued();
  if (!result.duplicate) pump(line);
  return { status: 202, body: { queued: true, position } };
}

module.exports = {
  submitPrompt,
  validNoticeId,
  MAX_KNOWN_NOTICES,
  serializePlannerRequest,
  restoreKnownNoticeIds,
  writeFileDurable,
  enqueuePlannerRequest,
  sourceIdentity,
  plannerRequest,
  interactionReportRequest,
  FLOW_INTERACTIONS,
  restorePlannerRequest,
  recordedPlannerRequest,
  retryPlannerRequest,
  serializePlannerRequests,
  restorePlannerRequests,
  queuedUserPromptProjection,
  cancelQueuedUserPrompt,
};
