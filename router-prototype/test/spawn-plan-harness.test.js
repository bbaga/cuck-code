"use strict";

// planHarnessRun and the registry-based system prompt channel. The golden
// values come from T01 (test/fixtures/golden/harness-argv.json).

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { planHarnessRun, usesSystemChannel, systemPromptOptions, briefForHarness } = require("../spawn-plan");
const { bootHarnesses } = require("../harness-boot");
const registry = require("../harness-registry");

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "golden", "harness-argv.json"), "utf8"));
const IDS = ["vibe", "pi", "codex", "claude"];
const cfg = (harness) => ({ harness, model: "model-x", effort: "medium", timeLimit: 120 });
const opts = { phase: "work", prompt: "Do the task", workdir: "/tmp/work", autoApprove: false };

bootHarnesses();
// Fake plugins register under a test id and leave after the test file.
after(() => registry.unregisterPluginHarnesses());

function fakePlugin(id, systemPrompt) {
  const base = registry.getHarness("claude").plugin;
  return { ...base, id, capabilities: { ...base.capabilities, systemPrompt } };
}

for (const id of IDS) {
  test(`planHarnessRun builds the contract request for ${id}`, () => {
    const { entry, request } = planHarnessRun(cfg(id), opts);
    assert.equal(entry, registry.getHarness(id));
    assert.deepEqual(request, {
      phase: "work", prompt: "Do the task", workdir: "/tmp/work", sessionId: null,
      model: "model-x", effort: "medium", timeLimitSec: 120, autoApprove: false,
      systemPrompt: null, systemPromptFile: null,
    });
  });

  test(`system prompt decisions of ${id} match the golden`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-plan-harness-"));
    try {
      const g = golden[id];
      assert.equal(usesSystemChannel(id, "role"), g.usesSystemChannelRole);
      assert.deepEqual(systemPromptOptions(id, "short", dir), g.systemPromptOptionsShort);
      const long = systemPromptOptions(id, "x".repeat(1200), dir);
      if (long.systemPromptFile) {
        assert.equal(g.systemPromptOptionsLong.systemPromptFile, "<TMP>" + long.systemPromptFile.slice(dir.length));
        assert.equal(fs.readFileSync(long.systemPromptFile, "utf8"), "x".repeat(1200));
      } else {
        assert.deepEqual(long, g.systemPromptOptionsLong);
      }
      assert.equal(briefForHarness(id, { prompt: "P", rolePrompt: "R", taskPrompt: "T" }), g.brief);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("planHarnessRun passes session and system prompt options", () => {
  const { request } = planHarnessRun(cfg("claude"), {
    ...opts, sessionId: "s-1", systemPrompt: "ROLE", systemPromptFile: "/tmp/p.txt",
  });
  assert.equal(request.sessionId, "s-1");
  assert.equal(request.systemPrompt, "ROLE");
  assert.equal(request.systemPromptFile, "/tmp/p.txt");
});

test("a plugin harness follows its own systemPrompt capability", () => {
  registry.registerHarness(fakePlugin("fake-file", "file"), { layer: "user", folder: "fake-file" });
  registry.registerHarness(fakePlugin("fake-text", "text"), { layer: "user", folder: "fake-text" });
  registry.registerHarness(fakePlugin("fake-none", "none"), { layer: "user", folder: "fake-none" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-plan-harness-"));
  try {
    const long = "y".repeat(1200);
    assert.ok(systemPromptOptions("fake-file", long, dir).systemPromptFile);
    assert.deepEqual(systemPromptOptions("fake-file", long, null), { systemPrompt: long });
    assert.deepEqual(systemPromptOptions("fake-text", long, dir), { systemPrompt: long });
    assert.deepEqual(systemPromptOptions("fake-none", long, dir), {});
    assert.equal(usesSystemChannel("fake-none", "role"), false);
    assert.equal(planHarnessRun(cfg("fake-text"), opts).entry.plugin.id, "fake-text");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    registry.unregisterPluginHarnesses();
  }
});

test("an unknown harness id throws", () => {
  assert.throws(() => planHarnessRun(cfg("nope"), opts), /unknown harness id: nope/);
  assert.throws(() => usesSystemChannel("nope", "role"), /unknown harness id: nope/);
  assert.throws(() => systemPromptOptions("nope", "role", null), /unknown harness id: nope/);
});
