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
const readRecords = (name) => fs.readFileSync(path.join(__dirname, "fixtures", `${name}.jsonl`), "utf8")
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

const CTX_REQUEST = {
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

function load(id, sdk) {
  return require(builtinFolder(id))(sdk);
}

test("both plugins pass validateHarnessPlugin", () => {
  for (const id of ["vibe", "codex"]) {
    const plugin = load(id, makeSdk().sdk);
    assert.deepStrictEqual(validateHarnessPlugin(plugin, { expectId: id, builtIn: true }), []);
  }
});

test("registerBuiltins registers the present built-ins", () => {
  registry.resetRegistryForTest();
  try {
    registerBuiltins(registry, makeSdk().sdk);
    assert.deepStrictEqual(registry.harnessIds().filter((id) => id === "vibe" || id === "codex"), ["vibe", "codex"]);
    const entry = registry.getHarness("vibe");
    assert.strictEqual(entry.layer, "built-in");
    assert.strictEqual(entry.builtIn, true);
    assert.strictEqual(entry.folder, builtinFolder("vibe"));
  } finally {
    registry.resetRegistryForTest();
  }
});

test("argv, env and cwd match harness-argv.json", () => {
  const golden = readGolden("harness-argv.json");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t06-"));
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
    for (const id of ["vibe", "codex"]) {
      for (const [name, patch] of Object.entries(patches)) {
        const { sdk, specs } = makeSdk();
        const plugin = load(id, sdk);
        const expected = golden[id].builds[name];
        const ctx = { sdk, env: {}, log() {} };
        const request = { ...CTX_REQUEST, ...patch };
        if (expected.error) {
          assert.throws(() => plugin.startSession(ctx, request, makeSink()),
            (err) => err.message === expected.error, `${id} ${name}`);
          continue;
        }
        plugin.startSession(ctx, request, makeSink());
        const { spec } = specs[0];
        assert.deepStrictEqual(
          { cmd: spec.cmd, args: spec.args, env: spec.env, cwd: spec.cwd === undefined ? null : spec.cwd },
          expected, `${id} ${name}`);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resumeSession builds the same plan as startSession with a session id", () => {
  const { sdk, specs } = makeSdk();
  const plugin = load("codex", sdk);
  plugin.resumeSession({ sdk, env: {}, log() {} }, { ...CTX_REQUEST, sessionId: "s-1" }, makeSink());
  assert.deepStrictEqual(specs[0].spec.args.slice(0, 3), ["exec", "resume", "s-1"]);
});

test("parser output matches harness-stream.json", () => {
  const golden = readGolden("harness-stream.json");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t06-home-"));
  const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = home; // keeps the context probe away from real sessions
  process.env.CODEX_HOME = path.join(home, ".codex");
  try {
    for (const id of ["vibe", "codex"]) {
      const { sdk, specs } = makeSdk();
      const plugin = load(id, sdk);
      const sink = makeSink();
      plugin.startSession({ sdk, env: {}, log() {} }, CTX_REQUEST, sink);
      const { parser } = specs[0];
      for (const record of readRecords(id)) parser.record(record, sink);
      parser.end(sink);

      const want = golden[id];
      assert.deepStrictEqual(sink.entries.map(({ at, ...rest }) => rest), want.entries, id);
      assert.strictEqual(sink.sessions[0], want.sessionId, id);
      assert.strictEqual(sink.errors.join("\n") || null, want.errorText, id);
      for (const [key, outcome] of Object.entries(want.outcomes)) {
        const [code, signal] = key.split(",");
        assert.strictEqual(
          parser.outcome(code === "null" ? null : Number(code), signal === "null" ? null : signal),
          outcome, `${id} ${key}`);
      }
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("stream errors reach sink.error", () => {
  const { sdk, specs } = makeSdk();
  load("codex", sdk).startSession({ sdk, env: {}, log() {} }, CTX_REQUEST, makeSink());
  const { parser } = specs[0];
  const sink = makeSink();
  parser.record({ type: "error", message: "boom" }, sink);
  parser.end(sink);
  assert.ok(sink.errors.every((t) => typeof t === "string"));
});

test("probe follows the probeHarnesses rules", async () => {
  const calls = [];
  const answers = {
    "vibe --version": { code: 0, stdout: "vibe 1.2\nmore" },
    "codex --version": { code: 0, stdout: "codex 0.9\n" },
    "codex login status": { code: 1, stdout: "" },
  };
  const { sdk } = makeSdk(async (argv) => { calls.push(argv.join(" ")); return answers[argv.join(" ")] || null; });
  const ctx = { sdk, env: {}, log() {} };
  assert.deepStrictEqual(await load("vibe", sdk).probe(ctx),
    { installed: true, version: "vibe 1.2", auth: "unknown", loginHint: "vibe --setup" });
  assert.deepStrictEqual(await load("codex", sdk).probe(ctx),
    { installed: true, version: "codex 0.9", auth: "missing", loginHint: "codex login" });
  answers["codex login status"] = { code: 0, stdout: "" };
  assert.strictEqual((await load("codex", sdk).probe(ctx)).auth, "ok");
  answers["codex login status"] = null;
  assert.strictEqual((await load("codex", sdk).probe(ctx)).auth, "unknown");
  answers["vibe --version"] = null;
  assert.deepStrictEqual(await load("vibe", sdk).probe(ctx),
    { installed: false, version: null, auth: "unknown", loginHint: "vibe --setup" });
});

test("listModels and readTranscript", async () => {
  const { sdk } = makeSdk();
  const ctx = { sdk, env: { VIBE_MODELS: "a-1,b-2" }, log() {} };
  const values = (await load("vibe", sdk).listModels(ctx, {})).map((c) => c.value);
  assert.ok(values.includes("a-1") && values.includes("b-2"));
  assert.strictEqual(await load("vibe", sdk).readTranscript(ctx, { sessionId: "x", workdir: "/tmp" }), null);
  assert.deepStrictEqual(await load("codex", sdk).listModels(ctx, {}), []);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t06-codex-"));
  try {
    const none = await load("codex", sdk).readTranscript(
      { ...ctx, env: { HOME: home, CODEX_HOME: home } }, { sessionId: "missing", workdir: "/tmp" });
    assert.strictEqual(none, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
