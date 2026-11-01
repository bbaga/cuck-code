"use strict";

// Task B5: the role part of a node prompt goes through the trusted system
// prompt channel; the task part stays in the user turn.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadBuiltinPipeline } = require("../line-graph");
const { buildPrompt, buildPromptParts, workerRouterValues, validatorRouterValues,
  integrationRouterValues, plannerRouterValues } = require("../prompt-builder");
const { planPlannerRun, planWorkerRun, systemPromptOptions, briefForHarness,
  usesSystemChannel } = require("../spawn-plan");

const root = path.join(__dirname, "..");
const graph = loadBuiltinPipeline("default", fs, root);
const line = { id: "line-9", name: "Line One" };
const repo = { name: "app" };

// buildPromptParts

function tiny(body, extra = {}) {
  return {
    start: "a",
    defaults: { prompt: "Default rule." },
    nodes: { a: { type: "t", fields: {}, prompt: "Node rule.", ...extra } },
    types: { t: { body, fields: { task: { type: "text", description: "d" } } } },
  };
}

test("buildPromptParts splits at the marker; extensions belong to the role", () => {
  const r = tiny("Rules.\n\n<!-- task -->\nTask: {{task}}\n");
  const parts = buildPromptParts(r, "a", {}, { task: "T" });
  assert.deepEqual(parts, { role: "Rules.\n\nDefault rule.\n\nNode rule.", task: "Task: T" });
  assert.equal(buildPrompt(r, "a", {}, { task: "T" }), "Rules.\n\nTask: T\n\nDefault rule.\n\nNode rule.");
});

test("buildPromptParts without a marker has an empty role and the whole prompt as task", () => {
  const r = tiny("Hello {{task}}.\n");
  assert.deepEqual(buildPromptParts(r, "a", {}, { task: "T" }),
    { role: "", task: "Hello T.\n\nDefault rule.\n\nNode rule." });
  assert.equal(buildPrompt(r, "a", {}, { task: "T" }), "Hello T.\n\nDefault rule.\n\nNode rule.");
});

test("a marker at the start gives the extensions as the role", () => {
  const r = tiny("<!-- task -->\nDo {{task}}.\n");
  assert.deepEqual(buildPromptParts(r, "a", {}, { task: "T" }),
    { role: "Default rule.\n\nNode rule.", task: "Do T." });
});

test("two markers are an error", () => {
  const r = tiny("A\n<!-- task -->\nB {{task}}\n<!-- task -->\nC\n");
  assert.throws(() => buildPromptParts(r, "a", {}, { task: "T" }), /2 '<!-- task -->' markers/);
  assert.throws(() => buildPrompt(r, "a", {}, { task: "T" }), /markers/);
});

test("a marker in an extension and one in the type body are two markers", () => {
  const r = tiny("A\n<!-- task -->\nB {{task}}\n");
  r.nodes.a.prompt = "X <!-- task --> Y";
  assert.throws(() => buildPromptParts(r, "a", {}, { task: "T" }), /markers/);
});

test("a persona body joined parent-then-child works with the marker in the child", () => {
  const r = tiny("Parent rules.\n\nChild persona.\n\n<!-- task -->\nTask: {{task}}");
  const parts = buildPromptParts(r, "a", {}, { task: "T" });
  assert.equal(parts.task, "Task: T");
  assert.match(parts.role, /^Parent rules\.\n\nChild persona\./);
});

test("a persona body with the marker in the parent keeps the child text in the task", () => {
  const r = tiny("Parent rules.\n\n<!-- task -->\nTask: {{task}}\n\nChild persona.");
  assert.equal(buildPromptParts(r, "a", {}, { task: "T" }).task, "Task: T\n\nChild persona.");
});

test("the built-in types carry the marker at the documented split points", () => {
  const rvW = (nodeId) => workerRouterValues({ line, nodeId, workerId: "w-1", workerName: "impl", repo,
    baseCommit: "abc", baseNote: "", port: 7788, changesetLimit: 500 });
  for (const persona of ["backend", "frontend"]) {
    const w = buildPromptParts(graph, `${persona}-impl`, rvW(`${persona}-impl`), { task: "Do it." });
    assert.ok(w.task.startsWith("Task from the planner:\nDo it."), `${persona} worker task`);
    assert.ok(w.role.length > 500 && !w.role.includes("Task from the planner:"));
    const v = buildPromptParts(graph, `${persona}-val`, validatorRouterValues({ line, nodeId: `${persona}-val`,
      workerId: "v-1", workerName: "val", implementor: { name: "impl-a", id: "w-1" }, report: "R",
      repoName: "app", repoUrl: null, port: 7788 }), { criteria: "1. ok" });
    assert.ok(v.task.startsWith("The implementor reported:\nR\n\nThe planner gave these acceptance criteria:\n1. ok"));
    assert.ok(!v.role.includes("The implementor reported:"));
  }
  const manifest = [{ name: "web", url: null, worktreePath: "/wt/web", baseSha: "a".repeat(40),
    branches: [{ name: "i", branch: "b", sha: "b".repeat(40) }] }];
  const i = buildPromptParts(graph, "integration", integrationRouterValues({ line, nodeId: "integration",
    workerId: "g-1", workerName: "int", manifest, branch: "integration/x", port: 7788 }), { instructions: "Go." });
  assert.ok(i.task.startsWith("Instructions from the planner:\nGo."));
  const prv = plannerRouterValues({ line, nodeId: graph.start, port: 7788, workerCap: 8, graph });
  const p = buildPromptParts(graph, graph.start, prv, { task: "Build X." });
  assert.ok(p.task.startsWith("Build X."));
  assert.ok(p.role.startsWith("PLANNER-ONLY RULES") && p.role.endsWith("(id line-9)."));
  assert.ok(!buildPrompt(graph, graph.start, prv, { task: "x" }).includes("<!-- task -->"));
});

// Plan arguments per harness

const FULL = "ROLE TEXT\n\nTASK TEXT";
const stored = { prompt: FULL, rolePrompt: "ROLE TEXT", taskPrompt: "TASK TEXT" };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b5-"));
const sysDir = path.join(dir, ".system-prompts");

function cfgFor(harness) {
  return { harness, model: harness === "vibe" ? "devstral" : "m", effort: "medium", timeLimit: 60 };
}

function planFor(kind, harness, over = {}) {
  const st = { ...stored, ...over };
  const opts = { prompt: briefForHarness(harness, st), workdir: "/tmp/wt", sessionId: null,
    autoApprove: true, ...systemPromptOptions(harness, st.rolePrompt, sysDir) };
  return kind === "worker"
    ? planWorkerRun(cfgFor(harness), { ...opts, phase: "implementor" })
    : planPlannerRun(cfgFor(harness), opts);
}

for (const kind of ["worker", "planner"]) {
  test(`vibe ${kind} run: the full prompt is the user turn, no system argument`, () => {
    const plan = planFor(kind, "vibe");
    assert.ok(plan.args.includes(FULL));
    assert.ok(!plan.args.some((a) => /system/.test(a)));
  });

  test(`pi ${kind} run: short role inline, task as the user turn`, () => {
    const plan = planFor(kind, "pi");
    const at = plan.args.indexOf("--append-system-prompt");
    assert.ok(at >= 0);
    assert.equal(plan.args[at + 1], "ROLE TEXT");
    assert.ok(plan.args.includes("TASK TEXT"));
    assert.ok(!plan.args.includes(FULL));
  });

  test(`codex ${kind} run: developer_instructions inline, never a file`, () => {
    const long = "R".repeat(5000);
    const plan = planFor(kind, "codex", { rolePrompt: long });
    assert.ok(plan.args.includes("-c"));
    assert.ok(plan.args.includes(`developer_instructions=${long}`));
    assert.ok(plan.args.includes("TASK TEXT"));
  });

  test(`claude ${kind} run: a long role goes through a router-owned 0600 file`, () => {
    const long = "R".repeat(5000);
    const plan = planFor(kind, "claude", { rolePrompt: long });
    const at = plan.args.indexOf("--append-system-prompt-file");
    assert.ok(at >= 0);
    const file = plan.args[at + 1];
    assert.equal(path.dirname(file), sysDir);
    assert.equal(fs.readFileSync(file, "utf8"), long);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(sysDir).mode & 0o777, 0o700);
    assert.ok(!plan.args.includes(long));
    assert.ok(plan.args.includes("TASK TEXT"));
  });
}

test("claude short role is inline text", () => {
  const plan = planFor("worker", "claude");
  const at = plan.args.indexOf("--append-system-prompt");
  assert.equal(plan.args[at + 1], "ROLE TEXT");
});

test("a resumed run sends the system prompt again", () => {
  const opts = { phase: "implementor", prompt: "continue", workdir: "/tmp/wt", sessionId: "s-1",
    autoApprove: true, ...systemPromptOptions("claude", "ROLE TEXT", sysDir) };
  const plan = planWorkerRun(cfgFor("claude"), opts);
  assert.ok(plan.args.includes("--append-system-prompt"));
  assert.ok(plan.args.includes("continue"));
});

test("a legacy record without the split keeps the full prompt in the user turn", () => {
  for (const harness of ["pi", "codex", "claude"]) {
    const legacy = { prompt: FULL };
    assert.equal(usesSystemChannel(harness, legacy.rolePrompt), false);
    assert.equal(briefForHarness(harness, legacy), FULL);
    assert.deepEqual(systemPromptOptions(harness, legacy.rolePrompt, sysDir), {});
  }
});

test("vibe ignores a stored role: full brief, no system options", () => {
  assert.equal(briefForHarness("vibe", stored), FULL);
  assert.deepEqual(systemPromptOptions("vibe", "ROLE TEXT", sysDir), {});
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
