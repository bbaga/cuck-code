"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { openRequest, transitionRequest } = require("../work-requests");

function opened(extra = {}) {
  return openRequest({ targetLineId: "target", text: "Please review", idempotencyKey: "key", ...extra }, "source", (id) => id === "target");
}

function rejects(fn) { assert.throws(fn, { code: "INVALID_REQUEST" }); }

test("opens with trusted source, compact outbox effect, and stable notification ID", () => {
  const { request, effects } = opened();
  assert.equal(request.sourceLineId, "source");
  assert.equal(request.state, "open");
  assert.equal(effects[0].id, `${request.id}:1:request.opened`);
  assert.deepEqual(Object.keys(effects[0]), ["id", "type", "requestId", "sourceLineId", "targetLineId"]);
});

test("replays an idempotency key without creating a request or notification", () => {
  const prior = opened().request;
  const replay = openRequest({ targetLineId: "other", text: "ignored", idempotencyKey: "key", existingRequests: [prior] }, "source", () => true);
  assert.equal(replay.request, prior);
  assert.deepEqual(replay.effects, []);
});

test("rejects forged fields, self requests, missing targets, and invalid text", () => {
  rejects(() => opened({ sourceLineId: "forged" }));
  rejects(() => openRequest({ targetLineId: "source", text: "x", idempotencyKey: "k" }, "source", () => true));
  rejects(() => openRequest({ targetLineId: "gone", text: "x", idempotencyKey: "k" }, "source", () => false));
  rejects(() => opened({ text: "  " }));
  rejects(() => opened({ idempotencyKey: "" }));
});

test("only target responds and revisions protect state changes", () => {
  const openedRequest = opened().request;
  rejects(() => transitionRequest(openedRequest, { state: "accepted", expectedRevision: 1 }, "source"));
  rejects(() => transitionRequest(openedRequest, { state: "accepted", expectedRevision: 0 }, "target"));
  rejects(() => transitionRequest(openedRequest, { state: "fulfilled", expectedRevision: 1 }, "target"));
  const accepted = transitionRequest(openedRequest, { state: "accepted", expectedRevision: 1 }, "target");
  assert.equal(accepted.request.revision, 2);
  assert.equal(accepted.request.state, "accepted");
  assert.equal(accepted.effects[0].id, `${openedRequest.id}:2:request.accepted`);
  rejects(() => transitionRequest(accepted.request, { state: "accepted", expectedRevision: 2 }, "target"));
  const fulfilled = transitionRequest(accepted.request, { state: "fulfilled", expectedRevision: 2 }, "target");
  assert.equal(fulfilled.request.state, "fulfilled");
});

test("declined requests cannot transition again and notification IDs do not collide", () => {
  const record = opened().request;
  const declined = transitionRequest(record, { state: "declined", expectedRevision: 1 }, "target");
  rejects(() => transitionRequest(declined.request, { state: "accepted", expectedRevision: 2 }, "target"));
  assert.notEqual(record.id + ":1:request.opened", declined.effects[0].id);
});
