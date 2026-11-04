"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { acceptStateStamp, queueRowLabel, createDraftOwner } = require("../web/pipeline-ui");

test("acceptStateStamp compares epoch and revision", () => {
  const cur = { epoch: "a", revision: 5 };
  assert.equal(acceptStateStamp(null, { epoch: "a", revision: 1 }), true);
  assert.equal(acceptStateStamp(cur, { epoch: "a", revision: 6 }), true);
  assert.equal(acceptStateStamp(cur, { epoch: "a", revision: 5 }), false);
  assert.equal(acceptStateStamp(cur, { epoch: "a", revision: 4 }), false);
  assert.equal(acceptStateStamp(cur, { epoch: "b", revision: 1 }), true);
});

test("acceptStateStamp rejects invalid incoming stamps", () => {
  const cur = { epoch: "a", revision: 5 };
  for (const bad of [undefined, null, {}, { epoch: "a" }, { revision: 9 }, { epoch: "", revision: 9 },
    { epoch: 1, revision: 9 }, { epoch: "a", revision: "9" }, { epoch: "a", revision: 1.5 }]) {
    assert.equal(acceptStateStamp(cur, bad), false);
    assert.equal(acceptStateStamp(null, bad), false);
  }
});

test("queueRowLabel shortens long text and flattens lines", () => {
  assert.equal(queueRowLabel({ position: 2, text: "hello" }), "Cancel queued prompt 2: hello");
  const long = queueRowLabel({ position: 1, text: "x".repeat(60) });
  assert.equal(long, "Cancel queued prompt 1: " + "x".repeat(40) + "…");
  assert.equal(queueRowLabel({ position: 3, text: "a\nb\n\nc" }), "Cancel queued prompt 3: a b c");
});

test("draft owner clears only an untouched, unchanged draft", () => {
  const d = createDraftOwner();
  d.touch();
  let t = d.begin("  hi ");
  assert.equal(d.canClear(t, "hi"), true);
  assert.equal(d.canClear(t, " hi \n"), true);
  assert.equal(d.canClear(t, "hi there"), false);
  t = d.begin("hi");
  d.touch();
  assert.equal(d.canClear(t, "hi"), false);
  assert.equal(d.canClear(null, "hi"), false);
});
