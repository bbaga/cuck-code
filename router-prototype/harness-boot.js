"use strict";

// Boots the harness registry: creates the SDK and registers the built-in
// harness plugins. Plugin layers (user, managed) register after this.

const childProcess = require("node:child_process");
const registry = require("./harness-registry");
const { createSdk, defaultRunCommand } = require("./harness-sdk");
const { registerBuiltins } = require("./harness-builtins");

// The SDK is created once and the built-ins keep it. It calls these
// bindings at call time, so a later boot can still set the real spawn and
// runCommand. A boot call without them keeps the earlier bindings.
let spawnBinding = null;
let runCommandBinding = null;
let sdk = null;

function createBootSdk() {
  return createSdk({
    spawn: (...args) => (spawnBinding || childProcess.spawn)(...args),
    runCommand: (...args) => (runCommandBinding || defaultRunCommand)(...args),
    getBuiltin: (id) => {
      const entry = registry.getHarness(id);
      return entry && entry.builtIn ? entry.plugin : null;
    },
  });
}

// Built-ins are registered once. A test that resets the registry gets a
// fresh registration, because the check reads the registry, not a flag.
function bootHarnesses({ spawn, runCommand } = {}) {
  if (spawn) spawnBinding = spawn;
  if (runCommand) runCommandBinding = runCommand;
  if (!sdk) sdk = createBootSdk();
  const booted = registry.harnessEntries().some((entry) => entry.builtIn);
  if (!booted) registerBuiltins(registry, sdk);
  return sdk;
}

module.exports = { bootHarnesses };
