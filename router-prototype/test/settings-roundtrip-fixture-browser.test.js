"use strict";
// Headless smoke test of the settings round-trip fixture itself: the fixture
// serves a real dashboard whose catalog lists both fake pi providers with
// distinct qualified models, a headless page boots with the stubs and no
// console errors, and the environment restores after a successful run, after
// a failing callback, after a throwing seed, and after close failures.
// The server module loads lazily, after the fixture installs its private
// LINES_DIR. Skips when no Chrome is available.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const H = require("./fixtures/settings-roundtrip-helpers");

// Read the server registry only after a fixture run. The fixture installs its
// private LINES_DIR before it loads the server, so this late require never
// binds the default ./lines directory of the caller's cwd.
const serverRegistry = () => require("../server").lines;

const envBefore = () => ({
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
});
const assertEnvRestored = (before) => {
  assert.equal(process.env.PATH, before.PATH);
  assert.equal(process.env.GIT_CONFIG_GLOBAL, before.GIT_CONFIG_GLOBAL);
  assert.equal(process.env.GIT_CONFIG_SYSTEM, before.GIT_CONFIG_SYSTEM);
};

test("fixture smoke: real catalog lists both known providers; page boots clean", async (t) => {
  const before = envBefore();
  await H.withFixture(t, null, async (holder, fx) => {
    // The fixture scoped PATH to its temporary fake CLI directory.
    assert.notEqual(process.env.PATH, before.PATH);
    assert.equal(process.env.GIT_CONFIG_GLOBAL, "/dev/null");

    // The real server catalog comes from probing the fake pi CLI: both
    // known providers with distinct provider-qualified models.
    const { harnesses } = await (await fetch(`${fx.url}/api/harnesses`)).json();
    const pi = harnesses.find((h) => h.id === "pi");
    assert.ok(pi && pi.installed, "the fake pi CLI is installed");
    assert.deepEqual(pi.authModes.map((m) => m.value), ["openai-codex", "anthropic"]);
    const models = pi.models.map((m) => m.value);
    assert.ok(models.includes("openai-codex/gpt-5.2"), "openai-codex model listed");
    assert.ok(models.includes("anthropic/claude-x"), "anthropic model listed");

    // The headless page lifecycle: the dashboard boots with the stubs and
    // collects no console errors.
    await holder.page.waitFor("/browser[- ]line/i.test(document.body.innerText)");
    assert.deepEqual(await holder.page.evaluate("window.__errs"), []);
  });
  // Every environment override is restored after the run.
  assertEnvRestored(before);
});

test("fixture smoke: a failing callback still cleans up and restores the environment", async (t) => {
  const before = envBefore();
  await assert.rejects(
    H.withFixture(t, null, async () => {
      assert.notEqual(process.env.PATH, before.PATH);
      throw new Error("controlled callback failure");
    }),
    /controlled callback failure/);
  assertEnvRestored(before);
});

test("fixture smoke: a throwing seed still cleans up and restores the environment", async (t) => {
  const before = envBefore();
  let binPath = null;
  await assert.rejects(
    H.withFixture(t, () => {
      // The seed runs inside the guard: the overrides are active here and
      // the first PATH entry is the temporary fake CLI directory.
      binPath = process.env.PATH.split(":")[0];
      assert.equal(process.env.GIT_CONFIG_GLOBAL, "/dev/null");
      throw new Error("seed exploded");
    }, async () => {}),
    /seed exploded/);
  // The seed error propagated; the environment, the temporary CLI directory,
  // and the fixture itself were cleaned up without a page ever existing.
  assertEnvRestored(before);
  assert.equal(fs.existsSync(binPath), false, "the temporary CLI directory is removed");
  assert.equal(serverRegistry().size, 0, "the fixture closed its line registry");
});

test("fixture smoke: close failures do not stop the other cleanup attempts", async (t) => {
  const before = envBefore();
  let binPath = null;
  let realFx = null;
  await assert.rejects(
    H.withFixture(t, null, async (holder, fx) => {
      binPath = process.env.PATH.split(":")[0];
      realFx = fx;
      throw new Error("run failed");
    }, {
      // Both seams wrap the real close step and then fail in a controlled
      // way, so the real resources are released and the errors are visible.
      pageClose: async (p) => { await p.close(); throw new Error("page close exploded"); },
      fixtureClose: async () => { await realFx.close(); throw new Error("fixture close exploded"); },
    }),
    (e) => /run failed/.test(e.message)
      && /page close exploded/.test(e.message)
      && /fixture close exploded/.test(e.message));
  // Both close attempts ran (their errors are aggregated into the primary
  // failure), and the environment and the temporary directory were restored.
  assertEnvRestored(before);
  assert.equal(fs.existsSync(binPath), false, "the temporary CLI directory is removed");
  assert.equal(serverRegistry().size, 0, "the fixture closed its line registry");
});

test("fixture smoke: a cleanup failure after a successful run is reported", async (t) => {
  const before = envBefore();
  let realFx = null;
  await assert.rejects(
    H.withFixture(t, null, async (holder, fx) => {
      realFx = fx;
    }, {
      fixtureClose: async () => { await realFx.close(); throw new Error("fixture close exploded"); },
    }),
    /fixture cleanup failed: fixture close: fixture close exploded/);
  assertEnvRestored(before);
  assert.equal(serverRegistry().size, 0, "the fixture closed its line registry");
});
