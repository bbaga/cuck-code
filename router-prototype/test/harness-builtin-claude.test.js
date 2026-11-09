"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { validateHarnessPlugin } = require("../harness-interface");
const registry = require("../harness-registry");
const { registerBuiltins, builtinFolder } = require("../harness-builtins");
const { createSdk } = require("../harness-sdk");
const claudeConfig = require("../claude-config");
const { claudeModelChoices } = require("../pipeline-config");

const GOLDEN = path.join(__dirname, "fixtures", "golden");
const readGolden = (name) => JSON.parse(fs.readFileSync(path.join(GOLDEN, name), "utf8"));
const records = fs.readFileSync(path.join(__dirname, "fixtures", "claude.jsonl"), "utf8")
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

const REQUEST = {
  phase: "work", prompt: "Do the task", workdir: "/tmp/work", sessionId: null,
  model: "model-x", effort: "medium", timeLimitSec: 120, autoApprove: false,
  systemPrompt: null, systemPromptFile: null,
};

function makeSdk(runCommand = async () => null) {
  const specs = [];
  const sdk = {
    ...createSdk({ runCommand }),
    spawnJsonl(spec, parser, sink) {
      specs.push({ spec, parser, sink });
      return { stop: () => true, done: Promise.resolve() };
    },
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

const load = (sdk) => require(builtinFolder("claude"))(sdk);

// Keeps the context probe away from real claude session files.
function withEmptyHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t07-home-"));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try { return fn(home); } finally {
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("plugin passes validateHarnessPlugin and registers last", () => {
  const plugin = load(makeSdk().sdk);
  assert.deepStrictEqual(validateHarnessPlugin(plugin, { expectId: "claude", builtIn: true }), []);
  assert.deepStrictEqual(plugin.capabilities,
    { resume: true, systemPrompt: "file", nativeTimeLimit: false, providers: false });
  registry.resetRegistryForTest();
  try {
    registerBuiltins(registry, makeSdk().sdk);
    assert.strictEqual(registry.harnessIds().pop(), "claude");
    assert.strictEqual(registry.getHarness("claude").folder, builtinFolder("claude"));
  } finally {
    registry.resetRegistryForTest();
  }
});

test("argv, env and cwd match harness-argv.json", () => {
  const golden = readGolden("harness-argv.json").claude;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t07-"));
  try {
    const promptFile = path.join(tmp, "system-prompt.txt");
    fs.writeFileSync(promptFile, "Be the role from a file.", "utf8");
    const patches = {
      "new session": {}, resume: { sessionId: "s-1" }, "model m-1": { model: "m-1" },
      "model null": { model: null }, "effort low": { effort: "low" },
      "effort high": { effort: "high" }, "effort max": { effort: "max" },
      "autoApprove true": { autoApprove: true }, "autoApprove false": { autoApprove: false },
      "system prompt none": {}, "system prompt inline": { systemPrompt: "Be the role." },
      "system prompt file": { systemPromptFile: promptFile },
      "dash prompt": { prompt: "--- PLANNER TURN CONTEXT ---\nDo the task" },
    };
    for (const [name, patch] of Object.entries(patches)) {
      const { sdk, specs } = makeSdk();
      const expected = golden.builds[name];
      const ctx = { sdk, env: {}, log() {} };
      const request = { ...REQUEST, ...patch };
      if (expected.error) {
        assert.throws(() => load(sdk).startSession(ctx, request, makeSink()),
          (err) => err.message === expected.error, name);
        continue;
      }
      load(sdk).startSession(ctx, request, makeSink());
      const { spec } = specs[0];
      assert.deepStrictEqual(
        {
          cmd: spec.cmd,
          // The golden file stands in for the temp prompt file path.
          args: spec.args.map((a) => (a === promptFile ? "<SYSTEM_PROMPT_FILE>" : a)),
          env: spec.env,
          cwd: spec.cwd === undefined ? null : spec.cwd,
        },
        expected, name);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resumeSession passes the session id to the claude argv", () => {
  const { sdk, specs } = makeSdk();
  load(sdk).resumeSession({ sdk, env: {}, log() {} }, { ...REQUEST, sessionId: "s-1" }, makeSink());
  assert.ok(specs[0].spec.args.includes("s-1"));
});

test("parser output matches harness-stream.json", () => withEmptyHome(() => {
  const want = readGolden("harness-stream.json").claude;
  const { sdk, specs } = makeSdk();
  const sink = makeSink();
  load(sdk).startSession({ sdk, env: {}, log() {} }, REQUEST, sink);
  const { parser } = specs[0];
  for (const record of records) parser.record(record, sink);
  parser.end(sink);
  assert.deepStrictEqual(sink.entries.map(({ at, ...rest }) => rest), want.entries);
  assert.strictEqual(sink.sessions[0], want.sessionId);
  assert.strictEqual(sink.errors.join("\n") || null, want.errorText);
  for (const [key, outcome] of Object.entries(want.outcomes)) {
    const [code, signal] = key.split(",");
    assert.strictEqual(
      parser.outcome(code === "null" ? null : Number(code), signal === "null" ? null : signal),
      outcome, key);
  }
}));

test("an is_error result fails the run on exit 0 and reaches sink.error", () => withEmptyHome(() => {
  const { sdk, specs } = makeSdk();
  const sink = makeSink();
  load(sdk).startSession({ sdk, env: {}, log() {} }, REQUEST, sink);
  const { parser } = specs[0];
  parser.record({ type: "result", subtype: "error", session_id: "c-1", is_error: true, result: "bad key" }, sink);
  parser.end(sink);
  assert.strictEqual(parser.outcome(0, null), "fail");
  assert.ok(sink.errors.join("\n").includes("bad key"));
}));

test("sink.error receives the same text as adapter.errorText()", () => withEmptyHome(() => {
  const { ClaudeHarness } = require("../harness");
  const failing = { type: "result", subtype: "error", session_id: "c-1", is_error: true, result: "bad key" };
  const reference = new ClaudeHarness("claude");
  reference.normalize(failing);
  const { sdk, specs } = makeSdk();
  const sink = makeSink();
  load(sdk).startSession({ sdk, env: {}, log() {} }, REQUEST, sink);
  specs[0].parser.record(failing, sink);
  specs[0].parser.end(sink);
  assert.strictEqual(sink.errors.join("\n") || null, reference.errorText());
}));

test("context probe gets the requested session id when the stream has none", () => {
  const contextProbe = require("../context-probe");
  const original = contextProbe.contextTokensForRun;
  const seen = [];
  contextProbe.contextTokensForRun = (adapter, sessionId) => { seen.push(sessionId); return 42; };
  try {
    const { sdk, specs } = makeSdk();
    const sink = makeSink();
    load(sdk).resumeSession({ sdk, env: {}, log() {} }, { ...REQUEST, sessionId: "req-1" }, sink);
    specs[0].parser.end(sink);
    assert.deepStrictEqual(sink.tokens, [42]);
    assert.deepStrictEqual(seen, ["req-1"]);
  } finally {
    contextProbe.contextTokensForRun = original;
  }
});

test("probe follows the probeHarnesses rules", async () => {
  const answers = {
    "claude --version": { code: 0, stdout: "2.1.0 (Claude Code)\nmore" },
    "claude auth status": { code: 0, stdout: "" },
  };
  const { sdk } = makeSdk(async (argv) => answers[argv.join(" ")] || null);
  const ctx = { sdk, env: {}, log() {} };
  assert.deepStrictEqual(await load(sdk).probe(ctx),
    { installed: true, version: "2.1.0 (Claude Code)", auth: "ok", loginHint: "claude login" });
  answers["claude auth status"] = { code: 1, stdout: "" };
  assert.strictEqual((await load(sdk).probe(ctx)).auth, "missing");
  answers["claude auth status"] = null;
  assert.strictEqual((await load(sdk).probe(ctx)).auth, "unknown");
  answers["claude --version"] = null;
  assert.deepStrictEqual(await load(sdk).probe(ctx),
    { installed: false, version: null, auth: "unknown", loginHint: "claude login" });
});

test("listModels uses the config reader and falls back when it throws", async () => {
  const original = claudeConfig.readClaudeConfig;
  const { sdk } = makeSdk();
  const ctx = { sdk, env: {}, log() {} };
  const config = { settings: { modelPickerOptions: [{ value: "m-pick", label: "Picked" }] } };
  try {
    claudeConfig.readClaudeConfig = async () => config;
    assert.deepStrictEqual(await load(sdk).listModels(ctx, {}), claudeModelChoices(config));
    claudeConfig.readClaudeConfig = async () => { throw new Error("unreadable"); };
    assert.deepStrictEqual(await load(sdk).listModels(ctx, {}), claudeModelChoices(null));
  } finally {
    claudeConfig.readClaudeConfig = original;
  }
});

test("readTranscript returns null when the session is missing", async () => {
  const { sdk } = makeSdk();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t07-claude-"));
  try {
    const result = await load(sdk).readTranscript(
      { sdk, env: { HOME: home }, log() {} }, { sessionId: "missing", workdir: "/tmp" });
    assert.strictEqual(result, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
