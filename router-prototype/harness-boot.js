"use strict";

// Boots the harness registry: creates the SDK and registers the built-in
// harness plugins. Plugin layers (user, managed) register after this.

const registry = require("./harness-registry");
const { createSdk } = require("./harness-sdk");
const { registerBuiltins } = require("./harness-builtins");

let sdk = null;

// Built-ins are registered once. A test that resets the registry gets a
// fresh boot, because the check reads the registry, not a private flag.
function bootHarnesses({ spawn, runCommand } = {}) {
  const booted = registry.harnessEntries().some((entry) => entry.builtIn);
  if (booted && sdk) return sdk;
  sdk = createSdk({
    spawn,
    runCommand,
    getBuiltin: (id) => {
      const entry = registry.getHarness(id);
      return entry && entry.builtIn ? entry.plugin : null;
    },
  });
  registerBuiltins(registry, sdk);
  return sdk;
}

module.exports = { bootHarnesses };
