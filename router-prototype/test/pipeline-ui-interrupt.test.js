"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createEscapeDetector, interruptEligibility, interruptOutcome } = require("../web/pipeline-ui.js");

const esc = (extra = {}) => ({ key: "Escape", ...extra });
const run = (events) => {
  const d = createEscapeDetector();
  return events.map(([e, t, ok = true]) => d.step(e, t, ok).trigger);
};

test("presses at 599 and 600 ms trigger; 601 ms arms again", () => {
  assert.deepEqual(run([[esc(), 0], [esc(), 599]]), [false, true]);
  assert.deepEqual(run([[esc(), 0], [esc(), 600]]), [false, true]);
  assert.deepEqual(run([[esc(), 0], [esc(), 601], [esc(), 1000]]), [false, false, true]);
});

test("a repeat event does not arm, trigger or reset", () => {
  assert.deepEqual(run([[esc({ repeat: true }), 0], [esc(), 10]]), [false, false]);
  assert.deepEqual(run([[esc(), 0], [esc({ repeat: true }), 100], [esc(), 200]]), [false, false, true]);
});

test("a held key never triggers", () => {
  const events = [[esc(), 0]];
  for (let i = 1; i < 30; i++) events.push([esc({ repeat: true }), i * 30]);
  assert.ok(run(events).every((t) => t === false));
});

test("another key or a modifier resets", () => {
  assert.deepEqual(run([[esc(), 0], [{ key: "a" }, 50], [esc(), 100]]), [false, false, false]);
  for (const m of ["ctrlKey", "altKey", "shiftKey", "metaKey"]) {
    assert.deepEqual(run([[esc({ [m]: true }), 0], [esc(), 50]]), [false, false], m + " first");
    assert.deepEqual(run([[esc(), 0], [esc({ [m]: true }), 50], [esc(), 100]]), [false, false, false], m + " second");
  }
});

test("composition resets", () => {
  assert.deepEqual(run([[esc(), 0], [esc({ isComposing: true }), 50], [esc(), 100]]), [false, false, false]);
  assert.deepEqual(run([[esc(), 0], [esc({ keyCode: 229 }), 50], [esc(), 100]]), [false, false, false]);
});

test("ineligible state resets and gives no trigger", () => {
  assert.deepEqual(run([[esc(), 0], [esc(), 50, false], [esc(), 100]]), [false, false, false]);
});

test("a third press after a trigger arms and does not trigger", () => {
  assert.deepEqual(run([[esc(), 0], [esc(), 100], [esc(), 200]]), [false, true, false]);
  assert.deepEqual(run([[esc(), 0], [esc(), 100], [esc(), 200], [esc(), 300]]), [false, true, false, true]);
});

test("reset() disarms", () => {
  const d = createEscapeDetector();
  d.step(esc(), 0, true);
  d.reset();
  assert.equal(d.step(esc(), 10, true).trigger, false);
});

test("interruptEligibility", () => {
  const ok = { plannerStatus: "running", activePlannerRunId: "r1", plannerCtx: null, stopPending: null, tab: "line" };
  assert.equal(interruptEligibility(ok), true);
  assert.equal(interruptEligibility({ ...ok, plannerStatus: "idle" }), false);
  assert.equal(interruptEligibility({ ...ok, plannerCtx: { compacting: true } }), false);
  assert.equal(interruptEligibility({ ...ok, activePlannerRunId: null }), false);
  assert.equal(interruptEligibility({ ...ok, activePlannerRunId: "" }), false);
  assert.equal(interruptEligibility({ ...ok, stopPending: { runId: "r1" } }), false);
  assert.equal(interruptEligibility({ ...ok, tab: "evidence" }), false);
});

test("interruptOutcome", () => {
  assert.deepEqual([202, 409, 404, 400, 500, 0, undefined].map(interruptOutcome),
    ["pending", "stale", "gone", "bad", "failed", "failed", "failed"]);
});
