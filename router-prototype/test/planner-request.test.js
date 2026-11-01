"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  plannerRequest,
  retryPlannerRequest,
  serializePlannerRequests,
  restorePlannerRequests,
  queuedUserPromptProjection,
  cancelQueuedUserPrompt,
} = require("../planner-request");

test("active and queued identical user prompts survive repeated restore with IDs", () => {
  const active = plannerRequest("wrapped A", null, "same text");
  const queued = plannerRequest("wrapped B", null, "same text");
  let state = { activePlannerRequest: active, plannerQueue: [queued] };
  for (let cycle = 0; cycle < 2; cycle++) {
    const restoredActive = restorePlannerRequests([state.activePlannerRequest])[0];
    const restoredQueue = restorePlannerRequests(state.plannerQueue);
    assert.deepEqual(restoredQueue.map((request) => request.id), [queued.id]);
    assert.equal(restoredActive.id, active.id);
    assert.notEqual(restoredActive.id, restoredQueue[0].id);
    state = { activePlannerRequest: restoredActive, plannerQueue: restoredQueue };
  }
});

test("legacy active and queued identical prompts get separate durable IDs", () => {
  const restored = restorePlannerRequests([{ text: "same", fromUser: true, userText: "same" },
    { text: "same", fromUser: true, userText: "same" }]);
  assert.equal(restored.length, 2);
  assert.notEqual(restored[0].id, restored[1].id);
});

test("cancellation removes only the matching waiting user request", () => {
  const first = plannerRequest("wrapped one", null, "same");
  const internal = plannerRequest("internal");
  const middle = plannerRequest("wrapped two", null, "same");
  const last = plannerRequest("wrapped three", null, "last");
  const line = { queue: [first, internal, middle, last], activePlannerRequest: null };
  const result = cancelQueuedUserPrompt(line, middle.id);
  assert.equal(result.status, "cancellable");
  assert.deepEqual(line.queue.map((request) => request.id), [first.id, internal.id, last.id]);
  assert.equal(cancelQueuedUserPrompt(line, middle.id).status, "unknown");
  assert.equal(cancelQueuedUserPrompt(line, internal.id).status, "internal");
  line.activePlannerRequest = first;
  assert.equal(cancelQueuedUserPrompt(line, first.id).status, "active");
});

test("duplicate user text gets distinct IDs and safe projection hides internal requests", () => {
  const first = plannerRequest("one", null, "same text");
  const second = plannerRequest("two", null, "same text");
  const internal = plannerRequest("internal");
  const rows = queuedUserPromptProjection([first, internal, second]);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(rows, [
    { id: first.id, text: "same text", position: 1 },
    { id: second.id, text: "same text", position: 2 },
  ]);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["id", "position", "text"]);
});

test("a retried request goes first and survives save and restore", () => {
  const active = plannerRequest("IMPLEMENTOR REPORT three");
  const queued = plannerRequest("IMPLEMENTOR REPORT two");
  const retryQueue = [queued];
  assert.equal(retryPlannerRequest(retryQueue, active), true);
  assert.equal(retryQueue[0].id, active.id);
  const persisted = JSON.parse(JSON.stringify(serializePlannerRequests(retryQueue)));
  const restored = restorePlannerRequests(persisted);
  assert.deepEqual(restored.map((request) => request.text), [active.text, queued.text]);
  assert.equal("source" in restored[0], false);
  assert.equal("source" in persisted[0], false);
});

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  enqueuePlannerRequest, writeFileDurable, restoreKnownNoticeIds,
  restorePlannerRequest, MAX_KNOWN_NOTICES,
} = require("../planner-request");

const okSave = () => true;
const newLine = () => ({ id: "L", queue: [], knownNoticeIds: [], deleted: false });

test("writeFileDurable writes the file and leaves no temp file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dur-"));
  const file = path.join(dir, "line.json");
  writeFileDurable(file, "{\"a\":1}");
  assert.equal(fs.readFileSync(file, "utf8"), "{\"a\":1}");
  assert.deepEqual(fs.readdirSync(dir), ["line.json"]);
});

test("writeFileDurable throws on rename error and keeps the old file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dur-"));
  const file = path.join(dir, "line.json");
  fs.writeFileSync(file, "old");
  const bad = { ...fs, renameSync() { throw new Error("rename boom"); } };
  assert.throws(() => writeFileDurable(file, "new", bad), /rename boom/);
  assert.equal(fs.readFileSync(file, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(dir), ["line.json"]);
});

test("enqueue succeeds after a good save", () => {
  const line = newLine();
  const r = enqueuePlannerRequest(line, plannerRequest("a", "n1"), okSave);
  assert.deepEqual(r, { ok: true, duplicate: false });
  assert.equal(line.queue.length, 1);
  assert.deepEqual(line.knownNoticeIds, ["n1"]);
});

test("request without noticeId behaves as before", () => {
  const line = newLine();
  enqueuePlannerRequest(line, plannerRequest("a"), okSave);
  const r = enqueuePlannerRequest(line, plannerRequest("a"), okSave);
  assert.equal(r.duplicate, false);
  assert.equal(line.queue.length, 2);
  assert.equal("noticeId" in line.queue[0], false);
});

test("failed or throwing save rolls back queue and notice list", () => {
  for (const save of [() => false, () => { throw new Error("x"); }]) {
    const line = newLine();
    const r = enqueuePlannerRequest(line, plannerRequest("a", "n1"), save);
    assert.deepEqual(r, { ok: false, reason: "save-failed" });
    assert.equal(line.queue.length, 0);
    assert.deepEqual(line.knownNoticeIds, []);
  }
});

test("deleted line and invalid request are rejected", () => {
  const line = newLine();
  line.deleted = true;
  assert.deepEqual(enqueuePlannerRequest(line, plannerRequest("a"), okSave),
    { ok: false, reason: "line-deleted" });
  line.deleted = false;
  assert.deepEqual(enqueuePlannerRequest(line, { nope: 1 }, okSave),
    { ok: false, reason: "invalid-request" });
  assert.equal(line.queue.length, 0);
});

test("duplicate noticeId in queue and after dispatch", () => {
  const line = newLine();
  enqueuePlannerRequest(line, plannerRequest("a", "n1"), okSave);
  assert.deepEqual(enqueuePlannerRequest(line, plannerRequest("b", "n1"), okSave),
    { ok: true, duplicate: true });
  line.queue.shift();
  assert.deepEqual(enqueuePlannerRequest(line, plannerRequest("c", "n1"), okSave),
    { ok: true, duplicate: true });
  assert.equal(line.queue.length, 0);
});

test("known notice list is bounded to 500", () => {
  const line = newLine();
  for (let i = 0; i < MAX_KNOWN_NOTICES + 5; i++) {
    enqueuePlannerRequest(line, plannerRequest("t", `n${i}`), okSave);
  }
  assert.equal(line.knownNoticeIds.length, MAX_KNOWN_NOTICES);
  assert.equal(line.knownNoticeIds[0], "n5");
  line.queue.length = 0;
  assert.equal(enqueuePlannerRequest(line, plannerRequest("t", "n0"), okSave).duplicate, false);
});

test("invalid noticeId is dropped", () => {
  assert.equal("noticeId" in plannerRequest("a", "bad id!"), false);
  assert.equal("noticeId" in plannerRequest("a", "x".repeat(129)), false);
});

test("restore after reload keeps noticeId and the list", () => {
  const line = newLine();
  enqueuePlannerRequest(line, plannerRequest("a", "n1"), okSave);
  const json = JSON.parse(JSON.stringify({
    plannerQueue: serializePlannerRequests(line.queue),
    knownNoticeIds: line.knownNoticeIds,
  }));
  const restored = restorePlannerRequests(json.plannerQueue);
  assert.equal(restored[0].noticeId, "n1");
  assert.equal(restorePlannerRequest(restored[0]).noticeId, "n1");
  assert.deepEqual(restoreKnownNoticeIds(json.knownNoticeIds), ["n1"]);
  assert.deepEqual(restoreKnownNoticeIds("junk"), []);
});

test("submitPrompt reports queue position before pump and pumps once", () => {
  const order = [];
  const line = { id: "l", started: true, queue: [] };
  const pump = (l) => { order.push("pump"); l.queue.shift(); };
  const out = require("../planner-request").submitPrompt(line, plannerRequest("a"),
    { wasStarted: true, save: () => true, pump, onQueued: () => order.push("log") });
  assert.deepEqual(out, { status: 202, body: { queued: true, position: 1 } });
  assert.deepEqual(order, ["log", "pump"]);
});

test("submitPrompt reports position 2 on a busy line", () => {
  const line = { id: "l", started: true, queue: [plannerRequest("x")] };
  const out = require("../planner-request").submitPrompt(line, plannerRequest("b"),
    { wasStarted: true, save: () => true, pump: () => {} });
  assert.equal(out.body.position, 2);
});

test("submitPrompt failed save returns 500, restores started, skips pump", () => {
  const line = { id: "l", started: true, queue: [] };
  let pumped = false;
  const out = require("../planner-request").submitPrompt(line, plannerRequest("c"),
    { wasStarted: false, save: () => false, pump: () => { pumped = true; } });
  assert.equal(out.status, 500);
  assert.match(out.body.error, /could not save prompt/);
  assert.equal(line.started, false);
  assert.equal(pumped, false);
  assert.equal(line.queue.length, 0);
});

test("submitPrompt maps invalid-request to 400, line-deleted to 410, save-failed to 500", () => {
  const { submitPrompt } = require("../planner-request");
  const opts = { wasStarted: true, save: () => true, pump: () => {} };
  assert.equal(submitPrompt({ id: "l", queue: [] }, { text: 5 }, opts).status, 400);
  assert.equal(submitPrompt({ id: "l", queue: [], deleted: true }, plannerRequest("a"), opts).status, 410);
  assert.equal(submitPrompt({ id: "l", queue: [] }, plannerRequest("a"), { ...opts, save: () => false }).status, 500);
});
