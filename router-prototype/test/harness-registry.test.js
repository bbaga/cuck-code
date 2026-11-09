"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert");

const reg = require("../harness-registry");

function plugin(id) {
  return {
    apiVersion: 1,
    id,
    capabilities: { resume: true, systemPrompt: "file", nativeTimeLimit: false, providers: false },
    probe: async () => ({}),
    listModels: async () => [],
    startSession: () => ({}),
    resumeSession: () => ({}),
  };
}

beforeEach(() => reg.resetRegistryForTest());

test("register and look up a plugin", () => {
  const p = plugin("remote-claude");
  reg.registerHarness(p, { layer: "user", folder: "/x/remote-claude" });
  const entry = reg.getHarness("remote-claude");
  assert.strictEqual(entry.plugin, p);
  assert.strictEqual(entry.layer, "user");
  assert.strictEqual(entry.folder, "/x/remote-claude");
  assert.strictEqual(entry.builtIn, false);
  assert.ok(reg.isHarness("remote-claude"));
  assert.strictEqual(reg.getHarness("nope"), null);
  assert.strictEqual(reg.isHarness("nope"), false);
});

test("order: built-ins first in fixed order, then plugins sorted", () => {
  reg.registerHarness(plugin("zeta"), { layer: "user", folder: "z" });
  reg.registerHarness(plugin("claude"), { layer: "builtin", folder: "c", builtIn: true });
  reg.registerHarness(plugin("alpha"), { layer: "user", folder: "a" });
  reg.registerHarness(plugin("vibe"), { layer: "builtin", folder: "v", builtIn: true });
  assert.deepStrictEqual(reg.harnessIds(), ["vibe", "claude", "alpha", "zeta"]);
  assert.deepStrictEqual(reg.harnessEntries().map((e) => e.plugin.id), ["vibe", "claude", "alpha", "zeta"]);
});

test("duplicate id throws", () => {
  reg.registerHarness(plugin("dup"), { layer: "user", folder: "d" });
  assert.throws(() => reg.registerHarness(plugin("dup"), { layer: "user", folder: "d2" }), /duplicate/);
});

test("reserved id without builtIn throws", () => {
  assert.throws(() => reg.registerHarness(plugin("claude"), { layer: "user", folder: "c" }));
  assert.strictEqual(reg.isHarness("claude"), false);
});

test("invalid plugin message lists all errors", () => {
  const bad = { apiVersion: 2, id: "bad" };
  assert.throws(
    () => reg.registerHarness(bad, { layer: "user", folder: "b" }),
    (err) => err.message.includes("apiVersion") && err.message.includes("probe") && err.message.includes(";"),
  );
  assert.throws(() => reg.registerHarness(null, { layer: "user", folder: "n" }));
});

test("unregisterPluginHarnesses keeps built-ins", () => {
  reg.registerHarness(plugin("pi"), { layer: "builtin", folder: "p", builtIn: true });
  reg.registerHarness(plugin("extra"), { layer: "user", folder: "e" });
  reg.unregisterPluginHarnesses();
  assert.deepStrictEqual(reg.harnessIds(), ["pi"]);
});
