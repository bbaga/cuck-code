"use strict";

// Reference pipelines of the choreographed pipelines, and a helper that
// resolves them against the real built-in node types and interactions.

const fs = require("node:fs");
const path = require("node:path");
const { resolvePipelineDefinition } = require("../resolve-pipeline");

const ROOT = path.join(__dirname, "..");
const dirs = (sub) => fs.readdirSync(path.join(ROOT, sub), { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name);

const NODES = `
start: planner
nodes:
  planner:     { type: planner }
  impl:        { type: backend-implementor }
  val:         { type: backend-validator, checks: [impl], maxRounds: 3 }
  batch:       { type: wait }
  integration: { type: integration-validator }
`;

// Pipeline 1: a chain with a wait node.
const CHAIN = `name: choreographed${NODES}edges:
  - planner -> impl: start, feedback, accept
  - impl -> val: handoff
  - impl -> planner: report
  - val -> impl: rework
  - val -> batch: arrive
  - val -> planner: report
  - planner -> batch: start
  - batch -> integration: handoff
  - batch -> planner: report
  - planner -> integration: start
  - integration -> planner: report
`;

// Pipeline 2: a stage of two checkers.
const STAGE = CHAIN
  .replace("nodes:\n", `nodes:
  lint: { type: script-check, checks: [impl], checkout: clean, maxRounds: 3, scripts: [{ name: diff-check, run: "git diff --check HEAD" }] }
`)
  .replace("impl -> val: handoff", "impl -> [val, lint]: handoff")
  .replace("val -> impl: rework", '"[val, lint] -> impl: rework"')
  .replace("val -> batch: arrive", '"[val, lint] -> batch: arrive"')
  .replace("val -> planner: report", '"[val, lint] -> planner: report"')
  .replace("impl -> [val, lint]: handoff", '"impl -> [val, lint]: handoff"');

function catalog(pipelineText) {
  const types = {};
  for (const n of dirs("node-types")) types[n] = { folder: path.join(ROOT, "node-types", n), layer: "built-in" };
  const interactions = {};
  for (const n of dirs("interactions")) {
    interactions[n] = { folder: path.join(ROOT, "interactions", n), layer: "built-in", builtIn: true };
  }
  return { readFile: (p) => fs.readFileSync(p, "utf8"), types, interactions,
    pipelines: { p: { text: pipelineText, layer: "managed" } } };
}

// The rule ids that a pipeline text breaks. An empty list means it is valid.
function rulesOf(text) {
  try {
    resolvePipelineDefinition("p", catalog(text));
    return [];
  } catch (err) {
    if (!err.errors) throw err;
    return [...new Set(err.errors.map((e) => e.rule))].sort();
  }
}

const resolve = (text) => resolvePipelineDefinition("p", catalog(text));

module.exports = { CHAIN, STAGE, catalog, resolve, rulesOf };
