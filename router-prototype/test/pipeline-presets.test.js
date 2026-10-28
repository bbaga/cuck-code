"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { presetError, restorePresets, createPresetStore } = require("../pipeline-presets");

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "presets-"));
  return { dir, file: path.join(dir, "pipeline-presets.json") };
}

test("presets need a name and a valid, non-empty pipeline", () => {
  assert.match(presetError("", { planner: { harness: "claude" } }), /name/);
  assert.match(presetError("x".repeat(61), { planner: { harness: "claude" } }), /at most 60/);
  assert.match(presetError("fast", null), /at least one phase/);
  assert.match(presetError("fast", {}), /at least one phase/);
  assert.match(presetError("fast", { planner: { harness: "nope" } }), /harness must be one of/);
  assert.strictEqual(presetError("fast", { planner: { harness: "claude", maxContext: 200000 } }), null);
});

test("restorePresets drops invalid and duplicate entries and sorts by name", () => {
  const restored = restorePresets([
    { name: "zeta", pipeline: { implementor: { effort: "high" } }, updatedAt: "t1" },
    { name: "bad", pipeline: { validator: { maxContext: 5000 } } },
    { name: " alpha ", pipeline: { planner: { harness: "pi" } } },
    { name: "alpha", pipeline: { planner: { harness: "codex" } } },
    null,
  ]);
  assert.deepStrictEqual(restored.map((p) => p.name), ["alpha", "zeta"]);
  assert.strictEqual(restored[0].pipeline.planner.harness, "pi");
  assert.deepStrictEqual(restorePresets("garbage"), []);
});

test("the store creates, replaces, lists, and removes presets on disk", () => {
  const { dir, file } = tempFile();
  try {
    const store = createPresetStore(file);
    assert.deepStrictEqual(store.list(), []);
    const now = new Date("2026-10-28T10:00:00Z");
    const created = store.put("claude 200K", { planner: { harness: "claude", maxContext: 200000 } }, now);
    assert.strictEqual(created.created, true);
    assert.strictEqual(created.preset.updatedAt, "2026-10-28T10:00:00.000Z");
    const replaced = store.put("claude 200K", { planner: { harness: "claude", maxContext: 50000 } }, now);
    assert.strictEqual(replaced.created, false);
    assert.match(store.put("bad", { validator: { maxContext: 1 } }).error, /not supported/);
    store.put("a-first", { implementor: { effort: "low" } }, now);

    const reread = createPresetStore(file).list();
    assert.deepStrictEqual(reread.map((p) => p.name), ["a-first", "claude 200K"]);
    assert.strictEqual(reread[1].pipeline.planner.maxContext, 50000);

    assert.strictEqual(store.remove("claude 200K"), true);
    assert.strictEqual(store.remove("claude 200K"), false);
    assert.deepStrictEqual(createPresetStore(file).list().map((p) => p.name), ["a-first"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt preset file starts empty instead of failing", () => {
  const { dir, file } = tempFile();
  try {
    fs.writeFileSync(file, "{not json");
    const store = createPresetStore(file);
    assert.deepStrictEqual(store.list(), []);
    assert.ok(store.put("ok", { planner: { effort: "high" } }).preset);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
