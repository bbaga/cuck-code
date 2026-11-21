"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { recordArrival, isReady, memberStates, batchReportText, missingReportText } = require("../wait-node");

const head = (id, runGeneration, extra = {}) => ({ id, name: `name-${id}`, branch: `b/${id}`, runGeneration,
  status: "completed", ...extra });
const checker = { id: "c1", name: "check-1" };
const workersOf = (...list) => new Map(list.map((w) => [w.id, w]));
const waitOf = (members) => ({ node: "batch", name: "batch-1", members, arrivals: {} });

test("recordArrival stores the run, the checker and the time; it mutates and returns arrivals", () => {
  const wait = waitOf(["a"]);
  const out = recordArrival(wait, head("a", 2), checker, 99);
  assert.equal(out, wait.arrivals);
  assert.deepEqual(wait.arrivals.a, { runGeneration: 2, checkerId: "c1", at: 99 });
});

test("isReady: all arrived", () => {
  const a = head("a", 1);
  const b = head("b", 3);
  const wait = waitOf(["a", "b"]);
  recordArrival(wait, a, checker, 1);
  assert.equal(isReady(wait, workersOf(a, b)), false, "b has not arrived");
  recordArrival(wait, b, checker, 2);
  assert.equal(isReady(wait, workersOf(a, b)), true);
});

test("isReady: a stale arrival, a running member and a removed member block", () => {
  const a = head("a", 1);
  const wait = waitOf(["a"]);
  recordArrival(wait, a, checker, 1);
  a.runGeneration = 2;
  assert.equal(isReady(wait, workersOf(a)), false, "stale");
  a.runGeneration = 1;
  a.status = "running";
  assert.equal(isReady(wait, workersOf(a)), false, "running");
  assert.equal(isReady(wait, workersOf()), false, "removed");
});

test("memberStates gives waiting, arrived and stale in member order", () => {
  const [a, b, c] = [head("a", 1), head("b", 1), head("c", 1)];
  const wait = waitOf(["c", "a", "b"]);
  recordArrival(wait, a, checker, 1);
  recordArrival(wait, b, checker, 1);
  b.runGeneration = 2;
  assert.deepEqual(memberStates(wait, workersOf(a, b, c)), [
    { id: "c", name: "name-c", state: "waiting" },
    { id: "a", name: "name-a", state: "arrived" },
    { id: "b", name: "name-b", state: "stale" }]);
});

test("batchReportText: first line and one line for each member", () => {
  const a = head("a", 1);
  const b = head("b", 1);
  const wait = waitOf(["a", "b"]);
  recordArrival(wait, a, checker, 1);
  recordArrival(wait, b, checker, 1);
  const lines = batchReportText(wait, workersOf(a, b, checker)).split("\n");
  assert.equal(lines[0], "BATCH REPORT - wait node 'batch' instance 'batch-1': all 2 members passed.");
  assert.equal(lines.length, 3);
  assert.match(lines[1], /name-a.*id a.*branch b\/a.*check-1/);
});

test("missingReportText: first line counts the members that did not arrive", () => {
  const a = head("a", 1);
  const b = head("b", 1);
  const wait = waitOf(["a", "b"]);
  recordArrival(wait, a, checker, 1);
  const lines = missingReportText(wait, workersOf(a, b), "time limit reached").split("\n");
  assert.equal(lines[0], "BATCH REPORT - wait node 'batch' instance 'batch-1': time limit reached. 1 of 2 members did not arrive.");
  assert.match(lines[1], /name-a.*arrived/);
  assert.match(lines[2], /name-b.*waiting/);
});
