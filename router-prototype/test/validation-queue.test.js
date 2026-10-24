"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  flushPendingValidationQueue,
  removePendingValidations,
  serializePendingValidations,
  restorePendingValidations,
} = require("../validation-queue");
const { pendingValidationFor } = require("../handoff");

function makeLine(pending, workers) {
  return { pendingValidations: pending, workers: new Map(workers.map((worker) => [worker.id, worker])) };
}

function launchInto(line, launched) {
  return (item, worker) => {
    worker.status = "running";
    launched.push({ item, workerId: worker.id });
  };
}

function runningCount(line) {
  return [...line.workers.values()].filter((worker) => worker.status === "running").length;
}

function pending(id, criteria = `criteria-${id}`, report = `report-${id}`, runId = 1) {
  return { implWorkerId: id, criteria, report, runId };
}

test("builds a queued validation from the exact completed run and generation", () => {
  const worker = { id: "impl", runGeneration: 12, lastRunText: "report\n✓" };
  assert.deepEqual(pendingValidationFor(worker, "1. criteria\n2. criteria ✓"), {
    implWorkerId: "impl", criteria: "1. criteria\n2. criteria ✓", report: "report\n✓", runId: 12,
  });
});

test("retains a queued item while its implementor runs, even when capacity is free", () => {
  const item = pending("impl-running");
  const line = makeLine([item], [{ id: item.implWorkerId, status: "running", runGeneration: 1 }]);
  const launched = [];
  const result = flushPendingValidationQueue(line, {
    capacity: 4,
    runningCount: () => runningCount(line),
    launch: launchInto(line, launched),
  });
  assert.deepEqual(line.pendingValidations, [item]);
  assert.deepEqual(launched, []);
  assert.equal(result.retained, 1);
  assert.equal(result.discarded, 0);
});

test("launches eligible items and retains blocked items in a mixed queue", () => {
  const blocked = pending("impl-running", "old criteria", "old report", 2);
  const ready = pending("impl-ready", "ready criteria ✓", "ready report ✓", 3);
  const line = makeLine([blocked, ready], [
    { id: blocked.implWorkerId, status: "running", runGeneration: 2 },
    { id: ready.implWorkerId, status: "completed", runGeneration: 3 },
  ]);
  const launched = [];
  const result = flushPendingValidationQueue(line, {
    capacity: 4,
    runningCount: () => runningCount(line),
    launch: launchInto(line, launched),
  });
  assert.deepEqual(launched, [{ item: ready, workerId: ready.implWorkerId }]);
  assert.deepEqual(line.pendingValidations, [blocked]);
  assert.equal(result.launched, 1);
  assert.equal(result.retained, 1);
});

test("does not spin at full capacity and launches once when capacity becomes available", () => {
  const item = pending("impl-ready");
  const workers = Array.from({ length: 4 }, (_, index) => ({
    id: `busy-${index}`, status: "running", runGeneration: 1,
  }));
  workers.push({ id: item.implWorkerId, status: "completed", runGeneration: 1 });
  const line = makeLine([item], workers);
  const launched = [];
  const options = { capacity: 4, runningCount: () => runningCount(line), launch: launchInto(line, launched) };
  const fullPass = flushPendingValidationQueue(line, options);
  assert.deepEqual(line.pendingValidations, [item]);
  assert.equal(fullPass.inspected, 0);
  assert.equal(launched.length, 0);

  workers[0].status = "completed";
  const openPass = flushPendingValidationQueue(line, options);
  assert.equal(openPass.launched, 1);
  assert.equal(line.pendingValidations.length, 0);
  flushPendingValidationQueue(line, options);
  assert.equal(launched.length, 1);
});

test("keeps item and run association while running, then reports explicit supersession", () => {
  const item = pending("impl", "criteria from run 5", "report from run 5", 5);
  const worker = { id: "impl", status: "running", runGeneration: 6 };
  const line = makeLine([item], [worker]);
  const launched = [];
  const discards = [];
  const options = {
    capacity: 3,
    runningCount: () => runningCount(line),
    launch: launchInto(line, launched),
    onDiscard: (queued, current, reason) => discards.push({ queued, current, reason }),
  };
  flushPendingValidationQueue(line, options);
  assert.deepEqual(line.pendingValidations, [item]);
  assert.equal(launched.length, 0);
  worker.status = "completed";
  const completedPass = flushPendingValidationQueue(line, options);
  assert.equal(completedPass.discarded, 1);
  assert.equal(line.pendingValidations.length, 0);
  assert.deepEqual(discards, [{ queued: item, current: worker, reason: "superseded" }]);
  assert.equal(launched.length, 0);
});

test("scans one bounded pass so blocked entries do not starve ready entries", () => {
  const blockedA = pending("running-a");
  const blockedB = pending("running-b");
  const ready = pending("ready");
  const line = makeLine([blockedA, blockedB, ready], [
    { id: "running-a", status: "running", runGeneration: 1 },
    { id: "running-b", status: "running", runGeneration: 1 },
    { id: "ready", status: "completed", runGeneration: 1 },
  ]);
  const launched = [];
  const result = flushPendingValidationQueue(line, {
    capacity: 5,
    runningCount: () => runningCount(line),
    launch: launchInto(line, launched),
  });
  assert.equal(result.inspected, 3);
  assert.deepEqual(launched.map((entry) => entry.item), [ready]);
  assert.deepEqual(line.pendingValidations, [blockedA, blockedB]);
});

test("deliberately removes deleted workers and preserves queue data across save and restore", () => {
  const deleted = pending("deleted", "criteria d", "report d", 2);
  const live = pending("live", "1. Inspect ✓\n2. Verify!", "complete report ✓", 8);
  const queued = [deleted, live];
  const encoded = JSON.parse(JSON.stringify(serializePendingValidations(queued)));
  assert.deepEqual(restorePendingValidations(encoded), queued);

  const cancelled = removePendingValidations(queued, "deleted");
  assert.deepEqual(cancelled, [deleted]);
  assert.deepEqual(queued, [live]);
  const line = makeLine(queued, [{ id: "live", status: "completed", runGeneration: 8 }]);
  const launched = [];
  flushPendingValidationQueue(line, {
    capacity: 2,
    runningCount: () => runningCount(line),
    launch: launchInto(line, launched),
  });
  assert.deepEqual(launched, [{ item: live, workerId: "live" }]);
  assert.equal(launched[0].item.criteria, "1. Inspect ✓\n2. Verify!");
  assert.equal(launched[0].item.report, "complete report ✓");
});

test("drops an orphan queue item with an explicit missing-worker reason", () => {
  const orphan = pending("gone");
  const line = makeLine([orphan], []);
  const reasons = [];
  const result = flushPendingValidationQueue(line, {
    capacity: 1,
    runningCount: () => 0,
    launch: () => assert.fail("must not launch an orphan"),
    onDiscard: (_item, _worker, reason) => reasons.push(reason),
  });
  assert.equal(result.discarded, 1);
  assert.deepEqual(line.pendingValidations, []);
  assert.deepEqual(reasons, ["missing-worker"]);
});
