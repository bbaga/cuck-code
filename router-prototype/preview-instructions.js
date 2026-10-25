"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function safeText(value, limit = 8000) {
  return String(value || "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").slice(0, limit);
}
function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 3000 });
  return r.status === 0 ? r.stdout.trim() : null;
}
function appDirectory(root) {
  if (fs.existsSync(path.join(root, "package.json"))) return root;
  const nested = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith(".") && fs.existsSync(path.join(root, e.name, "package.json"))).map(e => path.join(root, e.name));
  return nested.length === 1 ? nested[0] : null;
}
function instructionFor(root, sha) {
  const dir = appDirectory(root);
  const directory = dir ? path.relative(root, dir) || "." : ".";
  const steps = [`Obtain the repository and check out the validated commit ${sha}.`];
  if (!dir) return { stack: "unknown", directory, url: null, packageManager: null, steps: [...steps, "Review the project documentation to identify the application directory, package manager, setup, and start commands."], prerequisites: ["Project documentation"], limitations: ["The application directory or package manager is ambiguous."], instructions: steps };
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch { pkg = {}; }
  const files = fs.readdirSync(dir);
  const managers = [files.includes("package-lock.json") || files.includes("npm-shrinkwrap.json") ? "npm" : null, files.includes("yarn.lock") ? "yarn" : null, files.includes("pnpm-lock.yaml") ? "pnpm" : null, files.includes("bun.lock") || files.includes("bun.lockb") ? "bun" : null].filter(Boolean);
  const manager = managers.length === 1 ? managers[0] : null;
  const install = manager === "npm" ? (files.includes("package-lock.json") || files.includes("npm-shrinkwrap.json") ? "npm ci" : "npm install") : manager === "yarn" ? "yarn install --frozen-lockfile" : manager === "pnpm" ? "pnpm install --frozen-lockfile" : manager === "bun" ? "bun install --frozen-lockfile" : null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const stack = deps.next ? "next" : deps.vite ? "vite" : deps["react-scripts"] ? "react-scripts" : deps.express ? "express" : "unknown";
  const limitations = [];
  if (!manager) limitations.push(managers.length ? "Multiple package manager lockfiles exist; select the intended manager." : "No supported package manager lockfile exists; confirm the intended manager from project documentation.");
  if (stack === "unknown" || !pkg.scripts?.start) limitations.push("The framework or start command is not recognized; follow project documentation.");
  const stepsOut = [...steps, `Enter application directory ${directory}.`, ...(install ? [`Install dependencies with ${install}.`] : ["Confirm the package manager and install command from project documentation."]), ...(pkg.scripts?.start ? ["Start with the documented npm start script."] : ["Use the start command documented by the project."]), "Open the URL reported by the application. Stop it with Ctrl+C."];
  return { stack, directory, url: null, packageManager: manager, steps: stepsOut, prerequisites: ["Required runtime and environment values from project documentation"], limitations, instructions: stepsOut };
}
function previewForLine(line) {
  const pass = [...line.workers.values()].find(w => w.kind === "integration" && w.role === "validator" && w.status === "completed" && w.verdict === "pass");
  const base = { eligible: false, availability: "unavailable", stale: false, sourceRevision: null, projectDirectory: null, expectedUrl: null, prerequisites: [], limitations: [] };
  if (!pass) return { ...base, reason: "No completed integration result has a PASS verdict." };
  const source = pass.validatedCommit || pass.sourceRevision || pass.integrationCommit;
  if (!source || !/^[a-f0-9]{40}$/i.test(source)) return { ...base, eligible: true, stale: true, reason: "The validated commit was not recorded; source is unavailable or unverified." };
  const workdir = path.resolve(pass.worktreePath || "");
  if (!fs.existsSync(workdir) || git(workdir, ["cat-file", "-e", `${source}^{commit}`]) === null) return { ...base, eligible: true, stale: true, reason: "The recorded validated source is unavailable." };
  const result = instructionFor(workdir, source);
  result.instructions = result.instructions.map(s => safeText(s, 500));
  return { eligible: true, availability: "available", stale: false, sourceRevision: source, projectDirectory: result.directory, expectedUrl: result.url, prerequisites: result.prerequisites, limitations: result.limitations, verified: true, commit: source, branch: safeText(pass.branch, 200), ...result };
}
module.exports = { previewForLine, instructionFor, safeText };
