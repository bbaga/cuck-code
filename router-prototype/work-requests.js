"use strict";

const { randomUUID } = require("node:crypto");

const STATES = new Set(["open", "accepted", "declined", "fulfilled"]);
const MAX_TEXT_LENGTH = 2000;
const MAX_KEY_LENGTH = 128;

function fail(message) {
  const error = new Error(message);
  error.code = "INVALID_REQUEST";
  throw error;
}

function lineId(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) fail(`Invalid ${label} line ID`);
  return value;
}

function notification(request, event) {
  return { id: `${request.id}:${request.revision}:${event}`, type: event,
    requestId: request.id, sourceLineId: request.sourceLineId, targetLineId: request.targetLineId };
}

function openRequest(input, actorLineId, lineExists) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("Invalid request input");
  if (Object.hasOwn(input, "sourceLineId") || Object.hasOwn(input, "source") || Object.hasOwn(input, "actorLineId")) fail("Source fields are not accepted");
  const source = lineId(actorLineId, "source");
  if (Array.isArray(input.existingRequests)) {
    const prior = input.existingRequests.find((item) => item && item.sourceLineId === source && item.idempotencyKey === input.idempotencyKey);
    if (prior) return { request: prior, effects: [] };
  }
  const target = lineId(input.targetLineId, "target");
  if (source === target) fail("A line cannot request itself");
  if (typeof lineExists !== "function" || !lineExists(target)) fail("Target line does not exist");
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > MAX_TEXT_LENGTH) fail("Invalid request text");
  if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > MAX_KEY_LENGTH) fail("Invalid idempotency key");
  const record = { id: randomUUID(), sourceLineId: source, targetLineId: target,
    text: input.text.trim(), idempotencyKey: input.idempotencyKey, state: "open", revision: 1 };
  return { request: record, effects: [notification(record, "request.opened")] };
}

function transitionRequest(request, input, actorLineId) {
  if (!request || typeof request !== "object" || !STATES.has(request.state) || !Number.isSafeInteger(request.revision) || request.revision < 1) fail("Invalid request record");
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("Invalid transition input");
  const actor = lineId(actorLineId, "actor");
  if (actor !== request.targetLineId) fail("Only the target line can respond");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== request.revision) fail("Stale request revision");
  const transitions = { open: ["accepted", "declined"], accepted: ["fulfilled"], declined: [], fulfilled: [] };
  if (!transitions[request.state].includes(input.state)) fail("Invalid state transition");
  const updated = { ...request, state: input.state, revision: request.revision + 1 };
  return { request: updated, effects: [notification(updated, `request.${input.state}`)] };
}

module.exports = { openRequest, transitionRequest, MAX_TEXT_LENGTH };
