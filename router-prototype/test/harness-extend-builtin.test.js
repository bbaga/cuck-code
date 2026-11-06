"use strict";

// sdk.extendBuiltin and the two example plugins. Spawn is faked, so no
// process starts.

const { test, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { validateHarnessPlugin } = require("../harness-interface");
const { createSdk } = require("../harness-sdk");
const { builtinFolder } = require("../harness-builtins");
const { loadHarnessPluginFolder } = require("../harness-loader");
const { loadBuiltinPipeline } = require("../line-graph");
const { registerHarness, unregisterPluginHarnesses } = require("../harness-registry");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "extend-builtin-"));
process.env.LINES_DIR = root;
const server = require("../server");
after(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => unregisterPluginHarnesses());

const EXAMPLES = path.join(__dirname, "..", "docs", "examples", "harness-plugins");
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "golden", "harness-argv.json"), "utf8")).claude;
const records = fs.readFileSync(path.join(__dirname, "fixtures", "claude.jsonl"), "utf8")
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

const REQUEST = {
  phase: "work", prompt: "Do the task", workdir: "/tmp/work", sessionId: null,
  model: "model-x", effort: "medium", timeLimitSec: 120, autoApprove: false,
  systemPrompt: null, systemPromptFile: null,
};

// Registry-backed sdk whose spawnJsonl records the spec and parser.
function makeSdk() {
  const specs = [];
  const sdk = createSdk({ getBuiltin: (id) => (["claude"].includes(id) ? require(builtinFolder(id))(sdk) : null) });
  sdk.spawnJsonl = (spec, parser, sink) => {
    specs.push({ spec, parser, sink });
    return { stop: () => true, done: Promise.resolve() };
  };
  return { sdk, specs };
}

function makeSink() {
  const sink = { entries: [], sessions: [], errors: [], tokens: [] };
  sink.entry = (e) => sink.entries.push(e);
  sink.session = (id) => sink.sessions.push(id);
  sink.error = (t) => sink.errors.push(t);
  sink.contextTokens = (n) => sink.tokens.push(n);
  return sink;
}

const extend = (sdk, extra = {}) => sdk.extendBuiltin("claude", {
  id: "ext", command: "wrapper", args: ["--first", "x"], env: { EXTRA: "1", CLAUDE_ENV_OVERRIDE: "mine" }, ...extra,
});

test("extendBuiltin throws for an unknown base", () => {
  const { sdk } = makeSdk();
  assert.throws(() => sdk.extendBuiltin("nope", { id: "x", command: "c" }), /unknown built-in harness: nope/);
});

test("extended plugin is valid and not a built-in", () => {
  const { sdk } = makeSdk();
  const plugin = extend(sdk);
  assert.deepStrictEqual(validateHarnessPlugin(plugin, { expectId: "ext", builtIn: false }), []);
  assert.equal(plugin.displayName, "ext");
  assert.equal(plugin.capabilities.providers, false);
  assert.equal(typeof plugin.readTranscript, "function");
});

test("argv is the override args plus the claude golden argv for each case", () => {
  const tmp = fs.mkdtempSync(path.join(root, "golden-"));
  const promptFile = path.join(tmp, "system-prompt.txt");
  fs.writeFileSync(promptFile, "Be the role from a file.");
  const patches = {
    "new session": {}, resume: { sessionId: "s-1" }, "model m-1": { model: "m-1" },
    "model null": { model: null }, "effort low": { effort: "low" },
    "effort high": { effort: "high" }, "effort max": { effort: "max" },
    "autoApprove true": { autoApprove: true }, "autoApprove false": { autoApprove: false },
    "system prompt none": {}, "system prompt inline": { systemPrompt: "Be the role." },
    "system prompt file": { systemPromptFile: promptFile },
    "dash prompt": { prompt: "--- PLANNER TURN CONTEXT ---\nDo the task" },
  };
  assert.deepStrictEqual(Object.keys(patches).sort(), Object.keys(GOLDEN.builds).sort());
  for (const [name, patch] of Object.entries(patches)) {
    const expected = GOLDEN.builds[name];
    const { sdk, specs } = makeSdk();
    const ctx = { sdk, env: {}, pluginDir: "/plugins/ext", log() {} };
    const request = { ...REQUEST, ...patch };
    if (expected.error) {
      assert.throws(() => extend(sdk).startSession(ctx, request, makeSink()), (e) => e.message === expected.error, name);
      continue;
    }
    extend(sdk).startSession(ctx, request, makeSink());
    const { spec } = specs[0];
    assert.equal(spec.cmd, "wrapper", name);
    assert.deepStrictEqual(spec.args.map((a) => (a === promptFile ? "<SYSTEM_PROMPT_FILE>" : a)),
      ["--first", "x", ...expected.args], name);
    // The base env of every claude case is empty, so only the override shows.
    assert.deepStrictEqual(spec.env, { ...expected.env, EXTRA: "1", CLAUDE_ENV_OVERRIDE: "mine" }, name);
  }
});

// Runs the claude.jsonl records through a parser and returns what the sink saw.
function feed(parser, sink) {
  for (const obj of records) parser.record(obj, sink);
  parser.end(sink);
  return { entries: sink.entries, sessions: sink.sessions, outcome: parser.outcome(0, null), errors: sink.errors };
}

test("parser parity with the built-in claude plugin", () => {
  const home = fs.mkdtempSync(path.join(root, "home-"));
  const saved = process.env.HOME;
  process.env.HOME = home; // keeps the context probe away from real session files
  try {
    const { sdk, specs } = makeSdk();
    const ctx = { sdk, env: {}, pluginDir: "/p", log() {} };
    sdk.builtin("claude").startSession(ctx, REQUEST, makeSink());
    extend(sdk).startSession(ctx, REQUEST, makeSink());
    const builtin = feed(specs[0].parser, makeSink());
    const extended = feed(specs[1].parser, makeSink());
    assert.ok(builtin.entries.length > 0);
    assert.deepStrictEqual(extended, builtin);
  } finally {
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
  }
});

test("a ./ command resolves against pluginDir; a bare command stays", async () => {
  const { sdk, specs } = makeSdk();
  const ran = [];
  sdk.runCommand = async (argv) => { ran.push(argv); return { code: 0, stdout: "1.2.3\nmore" }; };
  const ctx = { sdk, env: {}, pluginDir: "/plugins/ext", log() {} };

  const rel = extend(sdk, { command: "./bin/x", args: [], probe: { authArgs: ["auth"] } });
  rel.startSession(ctx, REQUEST, makeSink());
  rel.resumeSession(ctx, { ...REQUEST, sessionId: "s" }, makeSink());
  assert.equal(specs[0].spec.cmd, path.resolve("/plugins/ext", "bin/x"));
  assert.equal(specs[1].spec.cmd, path.resolve("/plugins/ext", "bin/x"));
  const probed = await rel.probe(ctx);
  assert.deepStrictEqual(ran, [
    [path.resolve("/plugins/ext", "bin/x"), "--version"],
    [path.resolve("/plugins/ext", "bin/x"), "auth"],
  ]);
  assert.deepStrictEqual(probed, { installed: true, version: "1.2.3", auth: "ok", loginHint: "see the ext plugin docs" });

  extend(sdk, { command: "bare" }).startSession(ctx, REQUEST, makeSink());
  assert.equal(specs[2].spec.cmd, "bare");
});

test("models option goes through normalizeChoices", async () => {
  const { sdk } = makeSdk();
  const plugin = extend(sdk, { models: ["a", { value: "b", label: "B" }, "a"] });
  assert.deepStrictEqual(await plugin.listModels({}, {}), [{ value: "a", label: "a" }, { value: "b", label: "B" }]);
});

test("both examples load from a CUCK_HOME copy", () => {
  const home = fs.mkdtempSync(path.join(root, "cuck-home-"));
  fs.cpSync(EXAMPLES, path.join(home, "harnesses"), { recursive: true });
  const { sdk } = makeSdk();
  for (const id of ["remote-claude", "echo"]) {
    const loaded = loadHarnessPluginFolder(path.join(home, "harnesses", id), sdk);
    assert.ok(loaded.plugin, JSON.stringify(loaded.errors));
    assert.equal(loaded.plugin.id, id);
  }
});

test("bin/remote-claude has mode 0755 in git", () => {
  const out = execFileSync("git", ["ls-files", "-s", "docs/examples/harness-plugins/remote-claude/bin/remote-claude"],
    { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.match(out, /^100755 /);
});

function setupWorker(harness) {
  const workdir = fs.mkdtempSync(path.join(root, "line-"));
  const line = { id: path.basename(workdir), name: "echo", workdir,
    status: "idle", deleted: false, compacting: false, started: true, planApproved: true,
    queue: [], transcript: [], workers: new Map(), clients: new Set(), inventory: new Map(),
    repos: new Map(), pendingValidations: [], sessionId: null, sessionCfg: null, context: null,
    graph: loadBuiltinPipeline("default", fs, path.join(__dirname, "..")),
    nodeSettings: { planner: { harness }, implementor: { harness } } };
  const worker = { id: "w1", name: "worker", role: "implementor", status: "running",
    overrides: { harness }, worktreePath: workdir, prompt: "Hello echo", transcript: [], sessionId: null };
  line.workers.set(worker.id, worker);
  return { line, worker };
}

const until = (check) => new Promise((resolve) => {
  const timer = setInterval(() => { if (check()) { clearInterval(timer); resolve(); } }, 5);
});
const settled = (worker) => () => worker.child === null && worker.status !== "running";

function registerEcho() {
  const plugin = require(path.join(EXAMPLES, "echo"))();
  registerHarness(plugin, { layer: "user", folder: path.join(EXAMPLES, "echo") });
  return plugin;
}

test("a worker on echo completes and the report is the echo text", async () => {
  registerEcho();
  const { line, worker } = setupWorker("echo");
  server.spawnWorker(line, worker, worker.prompt, false);
  await until(settled(worker));
  assert.equal(worker.status, "completed");
  assert.match(worker.sessionId, /^echo-/);
  assert.ok(worker.transcript.some((e) => e.role === "assistant" && e.text === "Hello echo"));
});

test("echo resumeSession keeps the given session id", async () => {
  const plugin = registerEcho();
  const sink = makeSink();
  const run = plugin.resumeSession({}, { ...REQUEST, sessionId: "keep-me" }, sink);
  assert.equal((await run.done).outcome, "ok");
  assert.deepStrictEqual(sink.sessions, ["keep-me"]);
  const first = makeSink();
  await plugin.startSession({}, REQUEST, first).done;
  assert.match(first.sessions[0], /^echo-/);
  assert.equal(first.entries[0].text, REQUEST.prompt.slice(0, 200));
});
