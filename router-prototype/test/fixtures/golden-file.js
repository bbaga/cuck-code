"use strict";

// Reads a golden text file from test/fixtures/golden/<name>.txt, byte for byte.
// The files hold the output of the old hard-coded prompt and report builders
// (removed in D9), produced once by a one-off script before the removal.
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "golden");

function golden(name) {
  return fs.readFileSync(path.join(DIR, `${name}.txt`), "utf8");
}

function slug(label) {
  return label.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

module.exports = { golden, slug };
