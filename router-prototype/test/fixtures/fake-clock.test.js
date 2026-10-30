"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createFakeClock } = require("./fake-clock");

test("clock observes boundaries and runs equal-time timers in insertion order", () => {
  const clock = createFakeClock(10);
  const calls = [];
  clock.setTimeout(() => calls.push(["late", clock.now]), 10);
  clock.setTimeout(() => calls.push(["first", clock.now]), 20);
  clock.setTimeout(() => calls.push(["second", clock.now]), 20);
  clock.advance(19);
  assert.equal(clock.now, 29);
  assert.deepEqual(calls, [["late", 20]]);
  clock.advance(1);
  assert.deepEqual(calls, [["late", 20], ["first", 30], ["second", 30]]);
});

test("clock cancels timers and runs timers scheduled by callbacks", () => {
  const clock = createFakeClock();
  const calls = [];
  const cancelled = clock.setTimeout(() => calls.push("cancelled"), 5);
  clock.clearTimeout(cancelled);
  clock.setTimeout(() => {
    calls.push("parent");
    clock.setTimeout(() => calls.push("child"), 0);
  }, 5);
  clock.advance(5);
  assert.deepEqual(calls, ["parent", "child"]);
  assert.equal(clock.now, 5);
});

test("clock uses no hidden real timers", () => {
  const clock = createFakeClock(100);
  let ran = false;
  clock.setTimeout(() => { ran = true; }, 1);
  assert.equal(ran, false);
  assert.equal(clock.now, 100);
  clock.advance(0);
  assert.equal(ran, false);
  clock.advance(1);
  assert.equal(ran, true);
});
