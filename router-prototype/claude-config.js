"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// Read only the three approved Claude files. The returned objects are filtered
// later by pipeline-config; this reader never logs or emits file contents.
function readClaudeConfig(home = os.homedir()) {
  return {
    settings: readJsonFile(path.join(home, ".claude", "settings.json")),
    localSettings: readJsonFile(path.join(home, ".claude", "settings.local.json")),
    gatewayCache: readJsonFile(path.join(home, ".claude", "cache", "gateway-models.json")),
  };
}

module.exports = { readClaudeConfig };
