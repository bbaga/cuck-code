"use strict";
// Headless smoke test of the settings round-trip fixture itself: the fixture
// serves a real dashboard whose catalog lists both fake pi providers with
// distinct qualified models, a headless page boots with the stubs and no
// console errors, and the environment restores after a successful run and
// after a failing callback. Skips when no Chrome is available.
const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("./fixtures/settings-roundtrip-helpers");

test("fixture smoke: real catalog lists both known providers; page boots clean", async (t) => {
  const before = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
  };
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
  assert.equal(process.env.PATH, before.PATH);
  assert.equal(process.env.GIT_CONFIG_GLOBAL, before.GIT_CONFIG_GLOBAL);
  assert.equal(process.env.GIT_CONFIG_SYSTEM, before.GIT_CONFIG_SYSTEM);
});

test("fixture smoke: a failing callback still cleans up and restores the environment", async (t) => {
  const before = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
  };
  await assert.rejects(
    H.withFixture(t, null, async () => {
      assert.notEqual(process.env.PATH, before.PATH);
      throw new Error("controlled callback failure");
    }),
    /controlled callback failure/);
  assert.equal(process.env.PATH, before.PATH);
  assert.equal(process.env.GIT_CONFIG_GLOBAL, before.GIT_CONFIG_GLOBAL);
  assert.equal(process.env.GIT_CONFIG_SYSTEM, before.GIT_CONFIG_SYSTEM);
});
