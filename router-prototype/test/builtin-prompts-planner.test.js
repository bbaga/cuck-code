"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadBuiltinPipeline } = require("../line-graph");
const { buildPrompt, buildPromptParts, plannerRouterValues, protocolSection } = require("../prompt-builder");

const root = path.join(__dirname, "..");
const line = { id: "line-1", name: "Alpha" };
const plannerPrompt = (graph, task = "Build the thing.", extra = {}) => buildPrompt(graph, graph.start,
  plannerRouterValues({ line, nodeId: graph.start, port: 7788, workerCap: 8, graph }), { task, ...extra });

const graph = loadBuiltinPipeline("default", fs, root);
const type = graph.types.planner;

test("planner header", () => {
  assert.equal(type.session, "resume");
  assert.equal(type.workspace, "coordinator");
  assert.equal(type.outcome, "none");
  assert.equal(type.coordinator, true);
  assert.deepEqual(Object.keys(type.fields).sort(), ["task", "trackerTicket"]);
  assert.equal(type.fields.trackerTicket.optional, true);
});

test("the planner prompt keeps the role, task and tracker ticket sentences", () => {
  const text = plannerPrompt(graph, "Build the thing.", { trackerTicket: "ABC-123" });
  assert.ok(text.startsWith("PLANNER-ONLY RULES\n"));
  assert.ok(text.includes("You are the PLANNER of factory line 'Alpha' (id line-1).\nBuild the thing."));
  assert.ok(text.includes("Tracker ticket: ABC-123. Require each related implementor branch to begin with exactly ABC-123."));
  assert.ok(!plannerPrompt(graph).includes("Tracker ticket:"));
  assert.ok(text.includes("Never infer approval from continue."));
  assert.ok(text.includes("## Harness readiness"));
});

test("the protocol markers wrap the factory protocol and the generated section", () => {
  const b = type.body;
  const s = b.indexOf("<!-- protocol:start -->\n## Factory protocol");
  const e = b.indexOf("<!-- protocol:end -->");
  assert.ok(s >= 0 && e > s);
  assert.ok(b.slice(s, e).includes("{{protocol}}"));
  assert.ok(b.slice(s, e).includes("6. Integration:"));
  assert.ok(b.slice(e).startsWith("<!-- protocol:end -->\n\n## Work registry"));
});

test("the generic steps stay and the old reply and route text is gone", () => {
  const text = plannerPrompt(graph);
  for (const sentence of [
    "After writing plan.md, reply with a short summary and STOP.",
    "When you receive PLAN APPROVED",
    "A maximum of 8 workers AND validators runs at the same",
    "http://localhost:7788/api/protocol/workers/<workerId>/remove",
    "NEVER commit to or push the main/master branch yourself.",
    "Removing DISCARDS the worker's local work",
    "http://localhost:7788/api/protocol/lines/line-1/repos",
  ]) assert.ok(text.includes(sentence), `missing: ${sentence}`);
  for (const old of ["SKIP VALIDATION", "/workers \\", "/continue", "/integration "]) {
    assert.ok(!text.includes(old), `old text left: ${old}`);
  }
});

test("the generated section lists every allowed call of the default graph", () => {
  const section = protocolSection(graph, "planner", "http://localhost:7788", "line-1");
  assert.ok(plannerPrompt(graph).includes(section));
  const heads = section.split("\n").filter((l) => l.startsWith("### "));
  assert.deepEqual(heads, [
    "### start: node 'backend-impl'", "### start: node 'frontend-impl'",
    "### start: node 'backend-val'", "### start: node 'frontend-val'", "### start: node 'integration'",
    "### feedback: node 'backend-impl'", "### feedback: node 'frontend-impl'",
    "### accept: node 'backend-impl'", "### accept: node 'frontend-impl'",
  ]);
  assert.ok(section.includes(
    "curl -s -X POST http://localhost:7788/api/protocol/lines/line-1/interactions/start \\\n" +
    "  -H 'Content-Type: application/json' \\\n" +
    "  -d '{\"to\":\"backend-val\",\"criteria\":\"<criteria>\",\"source\":\"<source>\"}'"));
  assert.ok(section.includes("- source (instance of backend-val-source".replace("backend-val-source", "backend-impl") + ", required):"));
  assert.ok(section.includes("- instructions (text, required): The corrected or additional instructions"));
  assert.ok(section.includes("- reason (string, required): Why the work needs no check."));
  assert.ok(section.includes("-d '{\"instructions\":\"<instructions>\",\"instance\":\"<instance>\"}'"));
});

test("a small custom graph lists only the calls that have an edge", () => {
  const small = JSON.parse(JSON.stringify(graph));
  small.edges = small.edges.filter((e) => e.from !== "planner" || e.to === "backend-impl" || e.to === "backend-val");
  for (const e of small.edges) if (e.from === "planner" && e.to === "backend-impl") e.interactions = ["start", "feedback"];
  const section = protocolSection(small, "planner", "http://localhost:7788", "line-1");
  const heads = section.split("\n").filter((l) => l.startsWith("### "));
  assert.deepEqual(heads, ["### start: node 'backend-impl'", "### start: node 'backend-val'",
    "### feedback: node 'backend-impl'"]);
  assert.ok(!section.includes("interactions/accept"));
  assert.ok(!section.includes("frontend"));
  assert.ok(!section.includes("integration"));
});

test("only a coordinator gets a protocol section", () => {
  for (const id of ["backend-impl", "frontend-impl", "backend-val", "frontend-val", "integration"]) {
    assert.equal(protocolSection(graph, id, "http://localhost:7788", "line-1"), "");
  }
  assert.throws(() => protocolSection(graph, "ghost", "u", "l"), /unknown node/);
});

test("the role part of the planner holds the rules and the task part the request", () => {
  const rv = plannerRouterValues({ line, nodeId: graph.start, port: 7788, workerCap: 8, graph });
  const p = buildPromptParts(graph, graph.start, rv, { task: "Build X." });
  assert.ok(p.role.startsWith("PLANNER-ONLY RULES"));
  assert.ok(p.task.startsWith("Build X."));
  assert.ok(p.task.includes("## Calls"));
});
