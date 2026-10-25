"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { pendingValidationFor } = require("../handoff");
const {
  plannerRequest,
  implementorReportRequest,
  completePlannerCriteria,
  retryPlannerRequest,
  serializePlannerRequests,
  restorePlannerRequests,
} = require("../planner-request");
const { flushPendingValidationQueue } = require("../validation-queue");

function completedWorker(id, runId, invocationId, report) {
  return { id, name: id, status: "completed", runGeneration: runId,
    lastCompletedInvocationId: invocationId, lastRunText: report };
}

function reportRequest(worker, invocationId, runId, report) {
  return implementorReportRequest(`IMPLEMENTOR REPORT for ${worker.id}: ${report}`,
    worker, { invocationId, runId }, report);
}

function complete(request, criteria, workers, actions) {
  return completePlannerCriteria(request, criteria, {
    getWorker: (id) => workers.get(id),
    onCriteria: (source, value) => actions.criteria.push({ source, criteria: value }),
    onSkip: (source) => actions.skipped.push(source),
    onMissing: (source) => actions.missing.push(source),
    onSuperseded: (source) => actions.superseded.push(source),
    onIncompleteSource: () => actions.incomplete += 1,
  });
}

function actions() {
  return { criteria: [], skipped: [], missing: [], superseded: [], incomplete: 0 };
}

test("run 1 criteria cannot validate run 2 after continuation completes before criteria return", () => {
  const report1 = "Run 1 report: original changes ✓";
  const report2 = "Run 2 report: continuation changes !";
  const worker = completedWorker("impl-a", 1, "invocation-1", report1);
  const workers = new Map([[worker.id, worker]]);
  const request1 = reportRequest(worker, "invocation-1", 1, report1);
  const plannerActiveRequest = request1; // planner has started run 1's criteria response
  const line = { workers, pendingValidations: [], queue: [], capacity: 2 };
  const validators = [];
  const decisions = actions();

  // A continuation starts and completes while the planner is still processing request 1.
  worker.status = "running";
  worker.runGeneration = 2;
  worker.activeInvocationId = "invocation-2";
  worker.status = "completed";
  worker.lastCompletedInvocationId = "invocation-2";
  worker.lastRunText = report2;
  line.queue.push(reportRequest(worker, "invocation-2", 2, report2));

  const staleResult = complete(plannerActiveRequest, "1. Apply run 1 criteria.", workers, decisions);
  assert.equal(staleResult.decision, "superseded");
  assert.equal(decisions.criteria.length, 0);
  assert.equal(decisions.superseded.length, 1);
  assert.equal(line.pendingValidations.length, 0);
  assert.equal(validators.length, 0);
  assert.equal(line.queue.length, 1);
  assert.equal(line.queue[0].source.report, report2);
  assert.equal(line.queue[0].source.invocationId, "invocation-2");

  // The queued run 2 report remains independently eligible for its own criteria.
  const request2 = line.queue.shift();
  const currentResult = complete(request2, "1. Apply run 2 criteria.", workers, decisions);
  assert.equal(currentResult.decision, "criteria");
  const item = pendingValidationFor(decisions.criteria[0].source, decisions.criteria[0].criteria);
  line.pendingValidations.push(item);
  const launched = flushPendingValidationQueue(line, {
    capacity: line.capacity,
    runningCount: () => validators.length,
    launch: (queued) => validators.push({
      source: { workerId: queued.implWorkerId, invocationId: queued.invocationId,
        runId: queued.runId, report: queued.report },
      criteria: queued.criteria,
    }),
  });
  assert.equal(launched.launched, 1);
  assert.deepEqual(validators, [{
    source: { workerId: "impl-a", invocationId: "invocation-2", runId: 2, report: report2 },
    criteria: "1. Apply run 2 criteria.",
  }]);
  assert.ok(!validators.some((v) => v.criteria.includes("run 1") && v.source.report === report2));
});

test("rejects old criteria while a continuation is still running, then accepts its own report", () => {
  const report1 = "immutable run one";
  const report2 = "immutable run two";
  const worker = completedWorker("impl", 1, "inv-1", report1);
  const workers = new Map([[worker.id, worker]]);
  const oldRequest = reportRequest(worker, "inv-1", 1, report1);
  const outcomes = actions();

  worker.status = "running";
  worker.runGeneration = 2;
  worker.activeInvocationId = "inv-2";
  assert.equal(complete(oldRequest, "1. old criteria", workers, outcomes).decision, "superseded");
  assert.equal(outcomes.criteria.length, 0);
  assert.equal(outcomes.superseded.length, 1);

  worker.status = "completed";
  worker.lastCompletedInvocationId = "inv-2";
  worker.lastRunText = report2;
  const newRequest = reportRequest(worker, "inv-2", 2, report2);
  assert.equal(complete(newRequest, "1. new criteria", workers, outcomes).decision, "criteria");
  assert.equal(outcomes.criteria[0].source.report, report2);
});

test("unchanged run starts validation with its source report, not mutable latest text", () => {
  const report = "same invocation report ✓";
  const worker = completedWorker("impl", 7, "inv-7", report);
  const request = reportRequest(worker, "inv-7", 7, report);
  worker.lastRunText = "untrusted mutable fallback";
  const outcomes = actions();
  assert.equal(complete(request, "1. verify exact revision", new Map([[worker.id, worker]]), outcomes).decision,
    "criteria");
  const pending = pendingValidationFor(outcomes.criteria[0].source, outcomes.criteria[0].criteria);
  assert.equal(pending.report, report);
  assert.equal(pending.invocationId, "inv-7");
  assert.equal(pending.runId, 7);
});

test("trusted source metadata survives planner retries and save/restore", () => {
  const worker = completedWorker("impl", 3, "inv-3", "report three");
  const active = reportRequest(worker, "inv-3", 3, "report three");
  const queued = reportRequest(worker, "inv-2", 2, "older source");
  const retryQueue = [queued];
  assert.equal(retryPlannerRequest(retryQueue, active), true);
  assert.deepEqual(retryQueue[0].source, active.source);
  const persisted = JSON.parse(JSON.stringify(serializePlannerRequests(retryQueue)));
  const restored = restorePlannerRequests(persisted);
  assert.deepEqual(restored.map((request) => request.source), [active.source, queued.source]);
  assert.equal(restored[0].text, active.text);
  assert.equal(restored[1].source.invocationId, "inv-2");
});

test("source identity selects the correct worker when different workers finish", () => {
  const a = completedWorker("worker-a", 1, "inv-a", "report A");
  const b = completedWorker("worker-b", 4, "inv-b", "report B");
  const requestA = reportRequest(a, "inv-a", 1, "report A");
  const outcomes = actions();
  assert.equal(complete(requestA, "1. check A", new Map([[a.id, a], [b.id, b]]), outcomes).decision,
    "criteria");
  assert.equal(outcomes.criteria[0].source.workerId, "worker-a");
  assert.equal(outcomes.criteria[0].source.report, "report A");
});

test("diagnoses missing trusted source and never infers a report from mutable worker state", () => {
  const outcomes = actions();
  const result = complete(plannerRequest("IMPLEMENTOR REPORT worker-1 latest text"), "1. criteria",
    new Map([["worker-1", completedWorker("worker-1", 9, "inv-latest", "latest report")]]), outcomes);
  assert.equal(result.decision, "incomplete-source");
  assert.equal(outcomes.incomplete, 1);
  assert.equal(outcomes.criteria.length, 0);
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
  const r = enqueuePlannerRequest(line, plannerRequest("a", null, "n1"), okSave);
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
    const r = enqueuePlannerRequest(line, plannerRequest("a", null, "n1"), save);
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
  enqueuePlannerRequest(line, plannerRequest("a", null, "n1"), okSave);
  assert.deepEqual(enqueuePlannerRequest(line, plannerRequest("b", null, "n1"), okSave),
    { ok: true, duplicate: true });
  line.queue.shift();
  assert.deepEqual(enqueuePlannerRequest(line, plannerRequest("c", null, "n1"), okSave),
    { ok: true, duplicate: true });
  assert.equal(line.queue.length, 0);
});

test("known notice list is bounded to 500", () => {
  const line = newLine();
  for (let i = 0; i < MAX_KNOWN_NOTICES + 5; i++) {
    enqueuePlannerRequest(line, plannerRequest("t", null, `n${i}`), okSave);
  }
  assert.equal(line.knownNoticeIds.length, MAX_KNOWN_NOTICES);
  assert.equal(line.knownNoticeIds[0], "n5");
  line.queue.length = 0;
  assert.equal(enqueuePlannerRequest(line, plannerRequest("t", null, "n0"), okSave).duplicate, false);
});

test("invalid noticeId is dropped", () => {
  assert.equal("noticeId" in plannerRequest("a", null, "bad id!"), false);
  assert.equal("noticeId" in plannerRequest("a", null, "x".repeat(129)), false);
});

test("restore after reload keeps noticeId and the list", () => {
  const line = newLine();
  enqueuePlannerRequest(line, plannerRequest("a", null, "n1"), okSave);
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
