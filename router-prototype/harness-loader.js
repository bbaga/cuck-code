"use strict";

// Load one external harness plugin folder: <folder>/index.js exports a factory.
// loadHarnessPluginFolder never throws; plugin code is untrusted.

const fs = require("node:fs");
const path = require("node:path");
const { validateHarnessPlugin } = require("./harness-interface");

const message = (err) => (err instanceof Error ? err.message : String(err));

// A reload must see the new code, so every cached module of the folder goes.
// require.cache keys are real paths, so a symlinked folder needs both prefixes.
function clearFolderCache(folder) {
  const prefixes = [folder + path.sep];
  try { prefixes.push(fs.realpathSync(folder) + path.sep); } catch { /* a missing folder has no cache */ }
  for (const key of Object.keys(require.cache)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) delete require.cache[key];
  }
}

/**
 * @param {string} folder absolute plugin folder; its name is the plugin id
 * @param {object} sdk the harness SDK for the factory
 * @returns {{ plugin: object } | { errors: string[] }}
 */
function loadHarnessPluginFolder(folder, sdk) {
  let factory;
  try {
    clearFolderCache(folder);
    factory = require(path.join(folder, "index.js"));
  } catch (err) {
    return { errors: [`index.js cannot be loaded: ${message(err)}`] };
  }
  if (typeof factory !== "function") return { errors: ["index.js must export a factory function"] };

  let plugin;
  try {
    plugin = factory(sdk);
  } catch (err) {
    return { errors: [`factory threw: ${message(err)}`] };
  }
  if (plugin && typeof plugin.then === "function") {
    Promise.resolve(plugin).catch(() => {}); // no unhandled rejection from the refused plugin
    return { errors: ["the factory must return the plugin object synchronously, not a Promise"] };
  }
  const errors = validateHarnessPlugin(plugin, { expectId: path.basename(folder), builtIn: false });
  return errors.length ? { errors } : { plugin };
}

module.exports = { loadHarnessPluginFolder };
