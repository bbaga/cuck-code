"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadBuiltinPipeline } = require("../line-graph");
const { buildPrompt, workerRouterValues, validatorRouterValues, integrationRouterValues,
  plannerRouterValues } = require("../prompt-builder");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "server.js"), "utf8");

function cut(from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `marker "${from}" not found in server.js`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `marker "${to}" not found after "${from}"`);
  return source.slice(start, end);
}

// server.js starts a server when required: build the old functions from source.
const PORT = 7788;
const WORKER_CAP = 8;
const CHANGESET_LIMIT = 500;
const validationCriteriaBlock = (criteria) => `The planner gave these acceptance criteria:\n${criteria}`;
const oldCode = [
  cut("function plannerBrief(", "\n}\n") + "\n}\n",
  cut("function frontendToolsBlock(", "\nconst { wrapPlannerTurn"),
  cut("const IMPL_PERSONA", "\nconst VAL_PERSONA"),
  cut("const VAL_PERSONA", "\nfunction containersBlock"),
  cut("function containersBlock(", "\nfunction remoteBlockImplementor"),
  cut("function remoteBlockImplementor(", "function changesetBlock("),
  cut("function changesetBlock(", "function remoteBlockValidator("),
  cut("function remoteBlockValidator(", "\nfunction validatorBrief"),
  cut("function validatorBrief(", "\n\n\n// manifest:"),
  cut("function workerBrief(", "function remoteBlockValidator("),
  cut("function integrationValidatorBrief(", "\nfunction sanitizeName"),
].join("\n");
const old = new Function("PORT", "WORKER_CAP", "CHANGESET_LIMIT", "validationCriteriaBlock",
  `${oldCode}\nreturn { plannerBrief, workerBrief, validatorBrief, integrationValidatorBrief };`)(
  PORT, WORKER_CAP, CHANGESET_LIMIT, validationCriteriaBlock);

const graph = loadBuiltinPipeline("default", fs, root);
const line = { id: "line-9", name: "Line One" };

test("planner prompt equals plannerBrief", () => {
  const rv = plannerRouterValues({ line, nodeId: graph.start, port: PORT, workerCap: WORKER_CAP });
  const task = "Build the thing.\nSecond line.";
  assert.equal(buildPrompt(graph, graph.start, rv, { task }), old.plannerBrief(line.name, line.id, task, PORT));
});

for (const persona of ["backend", "frontend"]) {
  const repos = [
    ["no remote", { name: "app" }, undefined, "", "abc123"],
    ["remote", { name: "app", url: "git@example.com:org/app.git" }, undefined, "Base note.\n", "abc123"],
    ["ticket, no base commit", { name: "web", url: "https://example.com/org/web.git" }, "ABC-42", "", null],
  ];
  for (const [label, repo, ticket, note, commit] of repos) {
    test(`${persona} worker prompt equals workerBrief (${label})`, () => {
      const nodeId = `${persona}-impl`;
      const rv = workerRouterValues({ line, nodeId, workerId: "w-7", workerName: "impl-1", repo,
        baseCommit: commit, baseNote: note, port: PORT, changesetLimit: CHANGESET_LIMIT });
      const cv = { task: "Do the task.\nSecond line." };
      if (ticket) cv.trackerTicket = ticket;
      assert.equal(buildPrompt(graph, nodeId, rv, cv),
        old.workerBrief("impl-1", line.name, cv.task, persona, "w-7", line.id, repo, commit, note, ticket));
    });
  }

  const vcases = [
    ["no remote", "web", null, undefined, "w-3"],
    ["remote and ticket", "web", "https://github.com/o/web.git", "ABC-12", "w-3"],
    ["no repo name, no implementor id", "", "https://github.com/o/web.git", undefined, ""],
  ];
  for (const [label, repoName, repoUrl, ticket, implId] of vcases) {
    test(`${persona} validator prompt equals validatorBrief (${label})`, () => {
      const nodeId = `${persona}-val`;
      const report = "Done.\nTests pass.";
      const criteria = "1. It works.\n2. It is tidy.";
      const rv = validatorRouterValues({ line, nodeId, workerId: "v-1", workerName: "validator-impl",
        implementor: { name: "impl-a", id: implId }, report, repoName, repoUrl, port: PORT });
      const cv = { criteria };
      if (ticket) cv.trackerTicket = ticket;
      assert.equal(buildPrompt(graph, nodeId, rv, cv),
        old.validatorBrief("impl-a", report, criteria, persona, "v-1", implId, line.id, repoName, repoUrl, ticket));
    });
  }
}

test("integration validator prompt equals integrationValidatorBrief", () => {
  const manifest = [
    { name: "web", url: "https://github.com/o/web.git", worktreePath: "/wt/int/web", baseBranch: "main",
      baseSha: "a".repeat(40), branches: [{ name: "impl-a", branch: "feat/a", sha: "b".repeat(40) }] },
    { name: "api", url: null, worktreePath: "/wt/int/api", baseBranch: null, baseSha: "d".repeat(40),
      branches: [{ name: "impl-c", branch: "feat/c", sha: "e".repeat(40) },
        { name: "impl-d", branch: "feat/d", sha: "f".repeat(40) }] },
  ];
  const rv = integrationRouterValues({ line, nodeId: "integration", workerId: "g-1",
    workerName: "integration-validator", manifest, branch: "integration/x-1", port: PORT });
  const instructions = "Merge it\nthen test it";
  assert.equal(buildPrompt(graph, "integration", rv, { instructions }),
    old.integrationValidatorBrief(line, manifest, instructions, "g-1", "integration/x-1"));
  assert.match(buildPrompt(graph, "integration", rv, { instructions }), /created from HEAD at d{40}/);
});

// A tiny resolved pipeline in memory.
function tiny(extra = {}) {
  return {
    start: "a",
    defaults: { prompt: "Default rule for {{line.name}}." },
    nodes: { a: { type: "t", fields: {}, prompt: "Node rule: {{riskLevel}}.", ...extra } },
    types: { t: { body: "Hello {{task}} on {{line.name}}.\n", fields: { task: { type: "text", description: "d" } } } },
  };
}

test("buildPrompt joins body, defaults.prompt and node prompt with one empty line", () => {
  const r = tiny({ fields: { riskLevel: { type: "string", description: "d" } } });
  const out = buildPrompt(r, "a", { line: { name: "L" } }, { task: "T", riskLevel: "high" });
  assert.equal(out, "Hello T on L.\n\nDefault rule for L.\n\nNode rule: high.");
});

test("buildPrompt leaves out empty parts", () => {
  const r = { ...tiny(), defaults: {} };
  delete r.nodes.a.prompt;
  assert.equal(buildPrompt(r, "a", { line: { name: "L" } }, { task: "T" }), "Hello T on L.");
  const r2 = tiny();
  r2.defaults = { prompt: "   \n" };
  delete r2.nodes.a.prompt;
  assert.equal(buildPrompt(r2, "a", { line: { name: "L" } }, { task: "T" }), "Hello T on L.");
});

test("a missing value throws", () => {
  const r = tiny({ fields: { riskLevel: { type: "string", description: "d" } } });
  assert.throws(() => buildPrompt(r, "a", { line: { name: "L" } }, { task: "T" }), /Missing value "riskLevel"/);
  assert.throws(() => buildPrompt(r, "a", {}, { task: "T", riskLevel: "x" }), /Missing value/);
});

test("a caller value that names a router variable is rejected", () => {
  const r = tiny({ fields: { riskLevel: { type: "string", description: "d" } } });
  assert.throws(() => buildPrompt(r, "a", { line: { name: "L" } },
    { task: "T", riskLevel: "x", line: { name: "evil" } }), /router variable/);
  assert.throws(() => buildPrompt(r, "a", { line: { name: "L" }, hidden: "1" },
    { task: "T", riskLevel: "x", hidden: "2" }), /router variable/);
});

test("a caller value that is not a declared field is rejected", () => {
  const r = tiny({ fields: { riskLevel: { type: "string", description: "d" } } });
  assert.throws(() => buildPrompt(r, "a", { line: { name: "L" } },
    { task: "T", riskLevel: "x", extra: "y" }), /not a declared field/);
});

test("unknown node throws", () => {
  assert.throws(() => buildPrompt(tiny(), "zz", {}, {}), /unknown node/);
});
