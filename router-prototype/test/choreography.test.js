"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadBuiltinPipeline } = require("../line-graph");
const { CHAIN, STAGE, resolve } = require("./choreo-fixtures");
const { routeCompletion, maxRoundsOf, stageOf, resolveStage,
  combinedReworkText, combinedReportText, reworkLimitText } = require("../choreography");

const chain = resolve(CHAIN);
const stageGraph = resolve(STAGE);
const route = (graph, node, outcome, reworkRounds = 0) => routeCompletion({ graph, worker: { node }, outcome, reworkRounds });
const brief = (r) => r.actions.map((a) => [a.kind, a.to]);

test("impl done gives one handoff to val", () => {
  assert.deepEqual(brief(route(chain, "impl", "done")), [["handoff", "val"]]);
});

test("val pass gives one arrive to batch", () => {
  assert.deepEqual(brief(route(chain, "val", "pass")), [["arrive", "batch"]]);
});

test("val reject gives one rework to impl", () => {
  const r = route(chain, "val", "reject");
  assert.deepEqual(brief(r), [["rework", "impl"]]);
  assert.equal(r.exhausted, false);
});

test("val reject at the rework limit gives a fallback report", () => {
  const r = route(chain, "val", "reject", 3);
  assert.deepEqual(brief(r), [["report", "planner"]]);
  assert.equal(r.exhausted, true);
});

test("val failed gives a fallback report", () => {
  const r = route(chain, "val", "failed");
  assert.deepEqual(brief(r), [["report", "planner"]]);
  assert.equal(r.exhausted, false);
});

test("a node with only a report interaction reports every outcome", () => {
  const graph = loadBuiltinPipeline("default", fs, path.join(__dirname, ".."));
  for (const outcome of ["done", "pass", "reject", "missing", "timeout", "failed", "stopped"]) {
    assert.deepEqual(brief(route(graph, "backend-impl", outcome)), [["report", "planner"]], outcome);
  }
});

test("an unknown outcome throws", () => {
  assert.throws(() => route(chain, "val", "bogus"), /unknown outcome/);
});

test("maxRoundsOf reads the node and defaults to 3", () => {
  assert.equal(maxRoundsOf(chain, "val"), 3);
  assert.equal(maxRoundsOf(chain, "impl"), 3);
  assert.equal(maxRoundsOf({ nodes: { x: { maxRounds: 5 } } }, "x"), 5);
});

test("stageOf lists the checkers of a sender", () => {
  assert.deepEqual(stageOf(chain, "impl"), ["val"]);
  assert.deepEqual(stageOf(stageGraph, "impl"), ["val", "lint"]);
  assert.deepEqual(stageOf(chain, "val"), []);
});

const member = (outcome) => ({ status: outcome === "failed" ? "failed" : "completed", checkerId: "c", outcome });
const stage = (val, lint) => ({ sender: "impl", headRun: "h1", members: { val: member(val), lint: member(lint) } });
const resolveIt = (s, rounds = {}) => resolveStage({ graph: stageGraph, stage: s, reworkRounds: rounds });

test("a stage where all members pass arrives one time", () => {
  const r = resolveIt(stage("pass", "pass"));
  assert.deepEqual([r.kind, r.to, r.exhausted], ["arrive", "batch", false]);
  assert.deepEqual(r.passing, ["val", "lint"]);
});

test("a stage with one reject and one pass gives one combined rework", () => {
  const r = resolveIt(stage("reject", "pass"));
  assert.deepEqual([r.kind, r.to, r.exhausted], ["rework", "impl", false]);
  assert.deepEqual(r.rejecting, ["val"]);
  assert.deepEqual(r.passing, ["lint"]);
});

test("a stage with a reject at the limit gives a report with exhausted", () => {
  const r = resolveIt(stage("reject", "pass"), { impl: 3 });
  assert.deepEqual([r.kind, r.to, r.exhausted], ["report", "planner", true]);
});

test("a missing member gives a report, not a rework, even at the limit", () => {
  const r = resolveIt(stage("pass", "missing"), { impl: 3 });
  assert.deepEqual([r.kind, r.to, r.exhausted], ["report", "planner", false]);
  assert.deepEqual(r.rejecting, []);
  assert.deepEqual(r.indeterminate, ["lint"]);
});

test("a stage with only a missing member gives a report", () => {
  const r = resolveIt(stage("missing", "pass"), { impl: 0 });
  assert.deepEqual([r.kind, r.exhausted, r.rejecting, r.indeterminate], ["report", false, [], ["val"]]);
});

test("a reject with a missing member gives a rework that lists both", () => {
  const r = resolveIt(stage("reject", "missing"), { impl: 0 });
  assert.deepEqual([r.kind, r.to, r.rejecting, r.indeterminate], ["rework", "impl", ["val"], ["lint"]]);
});

test("a failed member goes before a missing member", () => {
  const r = resolveIt(stage("failed", "missing"));
  assert.deepEqual([r.kind, r.exhausted], ["report", false]);
});

test("a missing outcome never gives exhausted", () => {
  for (const rounds of [0, 2, 3, 4, 10]) {
    assert.equal(resolveIt(stage("missing", "pass"), { impl: rounds }).exhausted, false, `rounds ${rounds}`);
    assert.equal(resolveIt(stage("missing", "missing"), { impl: rounds }).exhausted, false, `rounds ${rounds}`);
  }
});

test("a missing validator of the choreographed pipeline gives no rework action", () => {
  const graph = loadBuiltinPipeline("choreographed", fs, path.join(__dirname, ".."));
  const node = Object.keys(graph.nodes).find((n) => stageOf(graph, "impl").includes(n));
  const r = route(graph, node, "missing");
  assert.ok(!r.actions.some((a) => a.kind === "rework"));
  assert.equal(r.exhausted, false);
});

test("a stage with a failed member gives a fallback report", () => {
  const r = resolveIt(stage("reject", "failed"));
  assert.deepEqual([r.kind, r.to, r.exhausted], ["report", "planner", false]);
});

test("a stage of one member matches routeCompletion", () => {
  const cases = [["pass", 0], ["reject", 0], ["reject", 3], ["failed", 0], ["timeout", 0]];
  for (const [outcome, rounds] of cases) {
    const s = { sender: "impl", headRun: "h", members: { val: member(outcome) } };
    const r = resolveStage({ graph: chain, stage: s, reworkRounds: { impl: rounds } });
    const expected = route(chain, "val", outcome, rounds);
    assert.deepEqual([r.kind, r.to, r.exhausted], [expected.actions[0].kind, expected.actions[0].to, expected.exhausted],
      `${outcome} ${rounds}`);
  }
});

test("a stage needs members with a known outcome", () => {
  assert.throws(() => resolveStage({ graph: chain, stage: { sender: "impl", members: {} } }), /at least one member/);
  assert.throws(() => resolveIt(stage("pass", "bogus")), /unknown outcome/);
});

test("the text builders write the exact headers", () => {
  const rework = combinedReworkText({ total: 2, bodies: ["BODY val"], passing: ["lint"] });
  assert.equal(rework.split("\n")[0], "REWORK REQUEST - 1 of 2 checkers rejected your latest run.");
  assert.ok(rework.includes("BODY val"));
  assert.ok(rework.endsWith("Checkers that passed: lint."));
  assert.ok(combinedReworkText({ total: 1, bodies: ["B"], passing: [] }).endsWith("Checkers that passed: none."));
  const report = combinedReportText({ headName: "t1", sender: "impl",
    members: [{ passed: true, text: "R val" }, { passed: false, text: "R lint" }] });
  assert.equal(report, "STAGE REPORT - 't1' after 'impl': 2 checkers, 1 PASS, 1 FAIL.\n\nR val\n\nR lint");
  assert.equal(reworkLimitText({ sender: "impl", headName: "t1", rounds: 3 }),
    "REWORK LIMIT REACHED - the checkers after 'impl' rejected 't1' 3 times. The router stopped the automatic rework.");
});
