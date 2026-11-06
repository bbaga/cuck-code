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

const GOLDEN = path.join(__dirname, "fixtures", "golden");
const readGolden = (name) => JSON.parse(fs.readFileSync(path.join(GOLDEN, name), "utf8"));
const readRecords = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8")
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

// Same catalog text as the fake pi CLI of harness-api.test.js.
const CATALOG = ["Provider  Model", "--------------------", "anthropic   claude-sonnet-4",
  "openai      gpt-5"].join("\n");

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

const load = (sdk) => require(builtinFolder("pi"))(sdk);
const ctxOf = (sdk) => ({ sdk, env: {}, log() {} });

// Keeps the context probe away from real session files.
function withEmptyHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t08-home-"));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try { return fn(home); } finally {
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// Fake runCommand: the pi catalog, the pi version and a configurable auth check.
function fakePi({ catalogCode = 0, auth = { code: 0, stdout: "" }, version = "pi 0.87.1" } = {}) {
  const calls = [];
  const run = async (argv) => {
    calls.push(argv.join(" "));
    if (argv[1] === "--version") return version === null ? null : { code: 0, stdout: `${version}\n` };
    if (argv[1] === "--list-models") {
      return catalogCode === 0
        ? { code: 0, stdout: `${CATALOG}\n` }
        : { code: catalogCode, stdout: "Failed to load catalog\n" };
    }
    if (argv[1] === "auth" && argv[2] === "check") return auth;
    return null;
  };
  return { run, calls };
}

test("plugin passes validateHarnessPlugin and registers second", () => {
  const plugin = load(makeSdk().sdk);
  assert.deepStrictEqual(validateHarnessPlugin(plugin, { expectId: "pi", builtIn: true }), []);
  assert.deepStrictEqual(plugin.capabilities,
    { resume: true, systemPrompt: "file", nativeTimeLimit: false, providers: true });
  registry.resetRegistryForTest();
  try {
    registerBuiltins(registry, makeSdk().sdk);
    assert.deepStrictEqual(registry.harnessIds(), ["vibe", "pi", "codex", "claude"]);
    assert.strictEqual(registry.getHarness("pi").folder, builtinFolder("pi"));
  } finally {
    registry.resetRegistryForTest();
  }
});

test("argv, env and cwd match harness-argv.json", () => {
  const golden = readGolden("harness-argv.json").pi;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t08-"));
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
      const request = { ...REQUEST, ...patch };
      if (expected.error) {
        assert.throws(() => load(sdk).startSession(ctxOf(sdk), request, makeSink()),
          (err) => err.message === expected.error, name);
        continue;
      }
      load(sdk).startSession(ctxOf(sdk), request, makeSink());
      const { spec } = specs[0];
      assert.deepStrictEqual(
        {
          cmd: spec.cmd,
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

test("resumeSession passes the session id to the pi argv", () => {
  const { sdk, specs } = makeSdk();
  load(sdk).resumeSession(ctxOf(sdk), { ...REQUEST, sessionId: "s-1" }, makeSink());
  assert.ok(specs[0].spec.args.includes("s-1"));
});

test("parser output matches harness-stream.json", () => withEmptyHome(() => {
  const want = readGolden("harness-stream.json").pi;
  const { sdk, specs } = makeSdk();
  const sink = makeSink();
  load(sdk).startSession(ctxOf(sdk), REQUEST, sink);
  const { parser } = specs[0];
  for (const record of readRecords("pi.jsonl")) parser.record(record, sink);
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

test("pi-handoff stream gives one completed message once", () => withEmptyHome(() => {
  const { sdk, specs } = makeSdk();
  const sink = makeSink();
  load(sdk).startSession(ctxOf(sdk), REQUEST, sink);
  for (const record of readRecords("pi-handoff.jsonl")) specs[0].parser.record(record, sink);
  specs[0].parser.end(sink);
  assert.deepStrictEqual(sink.entries.map((e) => e.text), ["1. Check the report ✓\n2. Preserve punctuation!"]);
  assert.strictEqual(sink.sessions[0], "pi-handoff-session");
}));

test("probe reports the version and never checks auth", async () => {
  const { run, calls } = fakePi();
  const { sdk } = makeSdk(run);
  assert.deepStrictEqual(await load(sdk).probe(ctxOf(sdk)),
    { installed: true, version: "pi 0.87.1", auth: "unknown", loginHint: "pi /login (in the pi TUI)" });
  assert.deepStrictEqual(calls, ["pi --version"]);
  const missing = makeSdk(fakePi({ version: null }).run);
  assert.deepStrictEqual(await load(missing.sdk).probe(ctxOf(missing.sdk)),
    { installed: false, version: null, auth: "unknown", loginHint: "pi /login (in the pi TUI)" });
});

test("listProviders and listModels read the catalog once per call", async () => {
  const { run, calls } = fakePi();
  const { sdk } = makeSdk(run);
  const plugin = load(sdk);
  assert.deepStrictEqual(await plugin.listProviders(ctxOf(sdk)),
    [{ value: "anthropic", label: "anthropic" }, { value: "openai", label: "openai" }]);
  assert.deepStrictEqual(calls, ["pi --list-models"]);
  assert.deepStrictEqual(await plugin.listModels(ctxOf(sdk), {}), [
    { value: "anthropic/claude-sonnet-4", label: "claude-sonnet-4" },
    { value: "openai/gpt-5", label: "gpt-5" },
  ]);
  assert.deepStrictEqual(await plugin.listModels(ctxOf(sdk), { provider: "openai" }),
    [{ value: "openai/gpt-5", label: "gpt-5" }]);
  assert.deepStrictEqual(await plugin.listModels(ctxOf(sdk), { provider: "nobody" }), []);
  assert.strictEqual(calls.length, 4);
});

test("a failed catalog command gives no providers and no models", async () => {
  for (const run of [fakePi({ catalogCode: 1 }).run, async () => null]) {
    const { sdk } = makeSdk(run);
    assert.deepStrictEqual(await load(sdk).listProviders(ctxOf(sdk)), []);
    assert.deepStrictEqual(await load(sdk).listModels(ctxOf(sdk), { provider: "openai" }), []);
  }
});

test("checkAuth follows piProviderDetail and never leaks secrets", async () => {
  const secret = '{"loginHint":"run pi /login","apiKey":"sk-secret"}';
  const cases = [
    [{ code: 0, stdout: secret }, { auth: "ok", loginHint: "run pi /login" }],
    [{ code: 1, stdout: "not logged in sk-secret" },
      { auth: "missing", loginHint: "pi /login (in the pi TUI)" }],
    [null, { auth: "unknown", loginHint: "pi /login (in the pi TUI)" }],
  ];
  for (const [auth, want] of cases) {
    const { run, calls } = fakePi({ auth });
    const { sdk } = makeSdk(run);
    const result = await load(sdk).checkAuth(ctxOf(sdk), { provider: "anthropic" });
    assert.deepStrictEqual(result, want);
    assert.ok(!JSON.stringify(result).includes("sk-secret"));
    assert.deepStrictEqual(calls, ["pi auth check --provider anthropic --json"]);
  }
});

test("readTranscript returns null when the session is missing", async () => {
  const { sdk } = makeSdk();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t08-pi-"));
  try {
    const result = await load(sdk).readTranscript(
      { sdk, env: { HOME: home }, log() {} }, { sessionId: "missing", workdir: "/tmp" });
    assert.strictEqual(result, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
