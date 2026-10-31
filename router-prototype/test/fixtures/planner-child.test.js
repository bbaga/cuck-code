"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createFakeChild } = require("./planner-child");

test("fake child exposes streams and does not close before explicit emission", () => {
  const child = createFakeChild();
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stdout.write("out");
  child.stderr.write("err");
  assert.deepEqual(output, ["out"]);
  let closes = 0;
  child.on("close", () => { closes += 1; });
  assert.equal(closes, 0);
  child.emitClose(0);
  child.emitClose(1);
  assert.equal(closes, 2);
});

test("fake child records signals and can fail signalling", () => {
  const child = createFakeChild({ signal: true });
  assert.equal(child.kill("SIGTERM"), false);
  assert.equal(child.kill("SIGKILL"), false);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("fake child emits explicit close and error events", () => {
  const child = createFakeChild({ close: 7 });
  const events = [];
  child.on("close", (code, signal) => events.push(["close", code, signal]));
  child.on("error", (error) => events.push(["error", error.message]));
  child.emitError(new Error("broken"));
  child.emitClose();
  assert.deepEqual(events, [["error", "broken"], ["close", 7, null]]);
});
