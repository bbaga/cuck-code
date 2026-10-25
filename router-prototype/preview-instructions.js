"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function safeText(value, limit = 8000) {
  return String(value || "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").slice(0, limit);
}

function git(workdir, args) {
  const result = spawnSync("git", ["-C", workdir, ...args], { encoding: "utf8", timeout: 3000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function instructionFor(root, sha) {
  const lines = [`Validated source: ${sha}`, "1. Obtain the validated source from the project repository.", `   git clone <repository-url> project && cd project && git checkout ${sha}`];
  let app = root;
  if (!fs.existsSync(path.join(app, "package.json")) && fs.existsSync(path.join(app, "router-prototype", "package.json"))) app = path.join(app, "router-prototype");
  if (!fs.existsSync(path.join(app, "package.json"))) {
    const nested = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => path.join(root, entry.name)).filter((dir) => fs.existsSync(path.join(dir, "package.json")));
    if (nested.length === 1) app = nested[0];
  }
  if (!fs.existsSync(path.join(app, "package.json"))) {
    lines.push("2. Read the project documentation and identify its required tools and environment.", "3. Do not use commands or settings that the project does not document.", "4. Start and stop the project by following its documented instructions.");
    return { stack: "unknown", directory: path.relative(root, app) || ".", url: null, instructions: lines };
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));
    const scripts = pkg.scripts || {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const supported = deps.next ? "next" : deps.vite ? "vite" : deps["react-scripts"] ? "react-scripts" : deps.express ? "express" : null;
    if (!supported || typeof scripts.start !== "string") {
      lines.push("2. Read the project documentation for its required environment and start command.", "3. Do not use commands or settings that the project does not document.", "4. Stop the project with its documented stop method.");
      return { stack: "unknown", directory: path.relative(root, app) || ".", url: null, instructions: lines };
    }
    lines.push(`2. Enter the application directory: ${path.relative(root, app) || "."}.`, "3. Install the dependencies with npm ci.");
    if (fs.existsSync(path.join(app, ".env.example"))) lines.push("4. Copy .env.example to .env and set required values from the project documentation.");
    const offset = lines.length + 1;
    lines.push(`${offset}. Start the application with npm start.`, `${offset + 1}. Open the URL shown by the application.`, `${offset + 2}. Stop the application with Ctrl+C.`);
    return { stack: supported, directory: path.relative(root, app) || ".", url: null, instructions: lines };
  } catch {
    lines.push("2. Read the project documentation and follow its setup instructions.", "3. Do not use commands or settings that the project does not document.");
    return { stack: "unknown", directory: ".", url: null, instructions: lines };
  }
}

function previewForLine(line) {
  const integrations = [...line.workers.values()].filter((w) => w.kind === "integration");
  const pass = integrations.find((w) => w.role === "validator" && w.status === "completed" && w.verdict === "pass");
  if (!pass) return { eligible: false, reason: "No completed integration result has a PASS verdict." };
  const workdir = path.resolve(pass.worktreePath || "");
  if (!workdir || !fs.existsSync(workdir) || !git(workdir, ["rev-parse", "--is-inside-work-tree"])) {
    return { eligible: true, verified: false, reason: "The validated source worktree is unavailable." };
  }
  const sha = git(workdir, ["rev-parse", "HEAD"]);
  const branch = git(workdir, ["branch", "--show-current"]);
  if (!sha || !/^[a-f0-9]{40}$/i.test(sha) || branch !== pass.branch) {
    return { eligible: true, verified: false, reason: "The validated source does not match its recorded branch." };
  }
  const result = instructionFor(workdir, sha);
  result.instructions = result.instructions.map((s) => safeText(s, 500));
  return { eligible: true, verified: true, commit: sha, branch: safeText(branch, 200), ...result };
}

module.exports = { previewForLine, instructionFor, safeText };
