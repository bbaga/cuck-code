"use strict";

// The boot SDK is created once and calls its spawn and runCommand bindings
// at call time. These tests load harness-boot fresh, without the server.

const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const registry = require("../harness-registry");

let bootHarnesses;
beforeEach(() => {
  registry.resetRegistryForTest();
  delete require.cache[require.resolve("../harness-boot")];
  ({ bootHarnesses } = require("../harness-boot"));
});
after(() => registry.resetRegistryForTest());

const spawnSpec = { cmd: "fake-cli", args: ["--x"], env: {}, cwd: "/tmp" };
const noParser = { record() {}, end() {}, outcome: () => "ok" };

// A spawn that fails at once, so the test needs no child process.
function recordingSpawn(calls) {
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    throw new Error("fake spawn");
  };
}

test("a later boot with arguments replaces the bindings of an earlier bare boot", async () => {
  const bare = bootHarnesses();
  const runs = [];
  const spawns = [];
  const fakeRun = async (argv) => { runs.push(argv); return { code: 0, stdout: "fake 9.9\n" }; };
  const sdk = bootHarnesses({ spawn: recordingSpawn(spawns), runCommand: fakeRun });
  assert.equal(sdk, bare);

  assert.deepEqual(await sdk.runCommand(["tool", "--version"]), { code: 0, stdout: "fake 9.9\n" });
  const probe = await registry.getHarness("pi").plugin.probe({});
  assert.equal(probe.installed, true);
  assert.ok(runs.length >= 2, "the plugin probe used fakeRun");

  assert.throws(() => sdk.spawnJsonl(spawnSpec, noParser, {}), /fake spawn/);
  assert.deepEqual(spawns, [["fake-cli", "--x"]]);
});

test("a bare boot keeps the bindings of an earlier boot", async () => {
  const spawns = [];
  const sdk = bootHarnesses({ spawn: recordingSpawn(spawns) });
  assert.equal(bootHarnesses(), sdk);
  assert.throws(() => sdk.spawnJsonl(spawnSpec, noParser, {}), /fake spawn/);
  assert.equal(spawns.length, 1);
});
