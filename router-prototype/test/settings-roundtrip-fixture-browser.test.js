"use strict";
// Headless smoke test of the settings round-trip fixture itself: the fixture
// serves a real dashboard whose catalog lists both fake pi providers with
// distinct qualified models, a headless page boots with the stubs and no
// console errors, and the environment restores after a successful run, after
// a failing callback, after a throwing seed, and after close failures. A
// subprocess regression proves the tests never touch the caller's working
// directory or a caller-supplied LINES_DIR. Skips when no Chrome is available.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const H = require("./fixtures/settings-roundtrip-helpers");

// The server registry is read only after a fixture run: the fixture installs
// its private LINES_DIR before the server module loads, so this late require
// never binds the default ./lines directory of the caller's cwd.
const serverRegistry = () => require("../server").lines;

const envBefore = () => ({
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
  LINES_DIR: process.env.LINES_DIR,
});
const assertEnvRestored = (before) => {
  assert.equal(process.env.PATH, before.PATH);
  assert.equal(process.env.GIT_CONFIG_GLOBAL, before.GIT_CONFIG_GLOBAL);
  assert.equal(process.env.GIT_CONFIG_SYSTEM, before.GIT_CONFIG_SYSTEM);
  assert.equal(process.env.LINES_DIR, before.LINES_DIR);
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

// The child run of this same file sets this flag; the isolation regression
// below must not recurse into another subprocess level.
const ISOLATION_CHILD = process.env.SETTINGS_ROUNDTRIP_ISOLATION_CHILD;

// Run this test file in a subprocess with the given cwd and LINES_DIR, and
// return the child. The child inherits this process's environment except for
// the isolation flag and the requested LINES_DIR handling.
function runIsolationChild(cwd, linesDir) {
  const env = { ...process.env, SETTINGS_ROUNDTRIP_ISOLATION_CHILD: "1" };
  if (linesDir === null) delete env.LINES_DIR;
  else if (linesDir !== undefined) env.LINES_DIR = linesDir;
  return spawnSync(process.execPath,
    ["--test", "--test-timeout=60000", "--test-force-exit",
      path.join(__dirname, "settings-roundtrip-fixture-browser.test.js")],
    { cwd, env, encoding: "utf8", timeout: 180000 });
}

test("fixture tests never touch the caller's working directory or LINES_DIR", {
  skip: ISOLATION_CHILD && "isolation child run",
}, async (t) => {
  // An empty cwd with LINES_DIR unset: the old eager server import bound the
  // default ./lines directory and wrote there. The subprocess must pass and
  // leave the cwd completely untouched.
  const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), "roundtrip-isolation-"));
  // A caller-supplied sentinel LINES_DIR: the fixture must write to its own
  // private directory and leave the sentinel empty, then restore the variable.
  const sentinel = fs.mkdtempSync(path.join(os.tmpdir(), "roundtrip-sentinel-"));
  try {
    const orphan = runIsolationChild(emptyCwd, null);
    assert.equal(orphan.status, 0,
      "the subprocess passes without LINES_DIR:\n" + (orphan.stdout || "").slice(-1500));
    assert.deepEqual(fs.readdirSync(emptyCwd), [],
      "no lines or work-coordination state appears in the empty cwd");

    const guarded = runIsolationChild(emptyCwd, sentinel);
    assert.equal(guarded.status, 0,
      "the subprocess passes with a sentinel LINES_DIR:\n" + (guarded.stdout || "").slice(-1500));
    assert.deepEqual(fs.readdirSync(sentinel), [],
      "the caller-supplied sentinel LINES_DIR stays untouched");
    assert.deepEqual(fs.readdirSync(emptyCwd), []);
  } finally {
    fs.rmSync(emptyCwd, { recursive: true, force: true });
    fs.rmSync(sentinel, { recursive: true, force: true });
  }
});
