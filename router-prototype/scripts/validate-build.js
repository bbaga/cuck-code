"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const PRODUCTION_SCRIPTS = [
  "server.js",
  "harness.js",
  "pipeline-config.js",
  "planner-policy.js",
  "spawn-plan.js",
  "handoff.js",
  "jsonl.js",
  "validation-queue.js",
  "planner-request.js",
  "web/pipeline-ui.js",
];
const REQUIRED_WEB_ASSETS = ["web/index.html", "web/pipeline-ui.js"];

function parseJavaScript(source, filename) {
  try {
    new vm.Script(source, { filename });
  } catch (error) {
    throw new Error(`Invalid JavaScript in ${filename}: ${error.message}`);
  }
}

function validateBuild(root = ROOT) {
  const errors = [];
  const read = (relative) => {
    const filename = path.join(root, relative);
    try {
      return fs.readFileSync(filename, "utf8");
    } catch (error) {
      errors.push(`Missing or unreadable file ${relative}: ${error.message}`);
      return null;
    }
  };

  for (const relative of REQUIRED_WEB_ASSETS) {
    if (!fs.existsSync(path.join(root, relative))) errors.push(`Missing required web asset: ${relative}`);
  }

  for (const relative of PRODUCTION_SCRIPTS) {
    const source = read(relative);
    if (source !== null) {
      try {
        parseJavaScript(source, relative);
      } catch (error) {
        errors.push(error.message);
      }
    }
  }

  const html = read("web/index.html");
  if (html !== null) {
    const scriptTags = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi);
    let inlineIndex = 0;
    for (const [, attributes, body] of scriptTags) {
      const src = attributes.match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
      if (src) {
        const asset = src[2];
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(asset)) continue;
        const localPath = path.resolve(root, "web", asset);
        const webRoot = path.resolve(root, "web") + path.sep;
        if (!localPath.startsWith(webRoot)) {
          errors.push(`Local script asset escapes web directory: ${asset}`);
        } else if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
          errors.push(`Missing local script asset: ${asset}`);
        }
      } else if (body.trim()) {
        inlineIndex += 1;
        try {
          parseJavaScript(body, `web/index.html inline script ${inlineIndex}`);
        } catch (error) {
          errors.push(error.message);
        }
      }
    }
  }

  if (errors.length) throw new Error(errors.join("\n"));
  return [
    ...PRODUCTION_SCRIPTS,
    "web/index.html inline scripts",
    "required and referenced local web assets",
  ];
}

if (require.main === module) {
  try {
    const checked = validateBuild();
    console.log(`Static JavaScript/build validation passed (${checked.length} checks).`);
    console.log("No transpilation build is defined for this plain-JavaScript application.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { validateBuild };
