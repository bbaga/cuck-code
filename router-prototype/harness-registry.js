"use strict";

// Registry of harness plugins. Built-in and user plugins register here
// after validation. Leaf module: it requires only harness-interface.js.

const { BUILTIN_HARNESS_IDS, validateHarnessPlugin } = require("./harness-interface");

/** @type {Map<string, { plugin: object, layer: string, folder: string, builtIn: boolean }>} */
const registry = new Map();

function registerHarness(plugin, { layer, folder, builtIn } = {}) {
  const errors = validateHarnessPlugin(plugin, {
    expectId: plugin && plugin.id,
    builtIn,
  });
  if (errors.length) {
    throw new Error(`invalid harness plugin: ${errors.join("; ")}`);
  }
  if (registry.has(plugin.id)) {
    throw new Error(`duplicate harness id: ${plugin.id}`);
  }
  const entry = { plugin, layer, folder, builtIn: Boolean(builtIn) };
  registry.set(plugin.id, entry);
  return entry;
}

// Called before a plugin reload. Built-ins stay.
function unregisterPluginHarnesses() {
  for (const [id, entry] of [...registry]) {
    if (!entry.builtIn) registry.delete(id);
  }
}

function getHarness(id) {
  return registry.get(id) || null;
}

function isHarness(id) {
  return registry.has(id);
}

// Built-ins keep their fixed order; plugins follow, sorted by id.
function harnessIds() {
  const builtIns = BUILTIN_HARNESS_IDS.filter((id) => registry.has(id));
  const plugins = [...registry.keys()]
    .filter((id) => !BUILTIN_HARNESS_IDS.includes(id))
    .sort();
  return [...builtIns, ...plugins];
}

function harnessEntries() {
  return harnessIds().map((id) => registry.get(id));
}

function resetRegistryForTest() {
  registry.clear();
}

module.exports = {
  registerHarness,
  unregisterPluginHarnesses,
  getHarness,
  isHarness,
  harnessIds,
  harnessEntries,
  resetRegistryForTest,
};
