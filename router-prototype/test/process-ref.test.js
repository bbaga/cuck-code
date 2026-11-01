"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isSignalablePid } = require("../process-ref");

test("refuses process groups, init, the router, and its parent", () => {
  const self = { pid: 500, ppid: 400 };
  for (const pid of [0, -1, -500, 1, 500, 400, 1.5, "123", null, undefined]) {
    assert.equal(isSignalablePid(pid, self), false, String(pid));
  }
});

test("accepts one other positive process ID", () => {
  assert.equal(isSignalablePid(12345, { pid: 500, ppid: 400 }), true);
});
