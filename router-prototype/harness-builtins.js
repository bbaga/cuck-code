"use strict";

// Loads the built-in harness plugins from harnesses/<id>/index.js and
// registers them. Only ids whose folder exists are loaded, so later tasks
// add a harness by adding its folder and listing its id here.

const fs = require("node:fs");
const path = require("node:path");

const BUILTIN_ORDER = ["vibe", "pi", "codex", "claude"];
const HARNESSES_DIR = path.join(__dirname, "harnesses");

function builtinFolder(id) {
  return path.join(HARNESSES_DIR, id);
}

function registerBuiltins(registry, sdk) {
  for (const id of BUILTIN_ORDER) {
    const folder = builtinFolder(id);
    if (!fs.existsSync(path.join(folder, "index.js"))) continue;
    const plugin = require(folder)(sdk);
    registry.registerHarness(plugin, { builtIn: true, layer: "built-in", folder });
  }
}

module.exports = { registerBuiltins, builtinFolder };
