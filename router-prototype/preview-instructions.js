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
function shellQuote(value) { return `'${String(value).replace(/'/g, "'\\''")}'`; }
function safeCloneUrl(value) {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x20\x7f]/.test(value)) return null;
  const url = value.trim();
  if (url.startsWith("git@")) return /^git@[^:]+:[^/]+\/[^/]+(?:\.git)?$/.test(url) ? url : null;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname.split("/").filter(Boolean).length !== 2) return null;
    return url;
  } catch { return null; }
  return url;
}
function instructionFor(root, sha, repoUrl) {
  const filesAt = (dir) => git(root, ["ls-tree", "-z", sha, "--", dir]);
  function exists(file) { return git(root, ["cat-file", "-e", `${sha}:${file}`]) !== null; }
  function read(file) {
    const result = spawnSync("git", ["-C", root, "show", `${sha}:${file}`], { encoding: "utf8", timeout: 3000 });
    return result.status === 0 ? result.stdout : null;
  }
  const rootPackage = exists("package.json");
  let relative = rootPackage ? "" : null;
  if (!rootPackage) {
    const entries = git(root, ["ls-tree", "-z", sha]);
    const candidates = entries ? entries.split("\0").map(v => v.split("\t")[1]).filter(Boolean).filter(name => exists(`${name}/package.json`)) : [];
    if (candidates.length === 1) relative = candidates[0];
  }
  const dir = relative === null ? null : (relative ? path.join(root, relative) : root);
  const directory = relative || ".";
  const cloneUrl = safeCloneUrl(repoUrl);
  const target = `cuck-code-${sha.slice(0, 8)}`;
  const steps = cloneUrl ? [{ description: "Clone the repository and check out the validated revision.", command: `git clone ${shellQuote(cloneUrl)} ${shellQuote(target)} && git -C ${shellQuote(target)} checkout --detach ${shellQuote(sha)}` }] : [{ description: "Obtain the repository and check out the validated revision manually. No safe repository URL is available.", command: null }];
  if (!dir) {
    const guidance = [...steps, { description: "Review project documentation to identify the application directory, package manager, setup, and start commands.", command: null }];
    return { stack: "unknown", directory, url: null, packageManager: null, steps: guidance, prerequisites: ["Project documentation"], limitations: ["The application directory or package manager is ambiguous."], instructions: guidance };
  }
  let pkg;
  try { pkg = JSON.parse(read(relative ? `${relative}/package.json` : "package.json")); } catch { pkg = {}; }
  const has = (name) => exists(relative ? `${relative}/${name}` : name);
  const files = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"].filter(has);
  const managers = [files.includes("package-lock.json") || files.includes("npm-shrinkwrap.json") ? "npm" : null, files.includes("yarn.lock") ? "yarn" : null, files.includes("pnpm-lock.yaml") ? "pnpm" : null, files.includes("bun.lock") || files.includes("bun.lockb") ? "bun" : null].filter(Boolean);
  const manager = managers.length === 1 ? managers[0] : null;
  const install = manager === "npm" ? (files.includes("package-lock.json") || files.includes("npm-shrinkwrap.json") ? "npm ci" : "npm install") : manager === "yarn" ? "yarn install --frozen-lockfile" : manager === "pnpm" ? "pnpm install --frozen-lockfile" : manager === "bun" ? "bun install --frozen-lockfile" : null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const stack = deps.next ? "next" : deps.vite ? "vite" : deps["react-scripts"] ? "react-scripts" : deps.express ? "express" : "unknown";
  const limitations = [];
  if (!manager) limitations.push(managers.length ? "Multiple package manager lockfiles exist; select the intended manager." : "No supported package manager lockfile exists; confirm the intended manager from project documentation.");
  if (stack === "unknown" || !pkg.scripts?.start) limitations.push("The framework or start command is not recognized; follow project documentation.");
  const stepsOut = [...steps, ...(cloneUrl ? [{ description: `Enter application directory ${directory}.`, command: `cd ${shellQuote(`${target}/${directory === "." ? "" : directory}`.replace(/\/$/, ""))}` }] : []), ...(cloneUrl ? (install ? [{ description: "Install the locked dependencies.", command: install }] : [{ description: "Confirm the package manager and install command from project documentation.", command: null }]) : []), ...(cloneUrl ? (pkg.scripts?.start && stack !== "unknown" ? [{ description: "Start the application.", command: "npm start" }] : [{ description: "Use the start command documented by the project.", command: null }]) : []), ...(cloneUrl ? [{ description: "Open the URL reported by the application. Stop it with Ctrl+C.", command: null }] : [])];
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
  const repos = [line.repoUrl, pass.repoUrl].filter(Boolean);
  const configuredUrl = repos.length === 1 ? repos[0] : null;
  const result = instructionFor(workdir, source, configuredUrl);
  result.steps = result.steps.map(step => ({ description: safeText(step.description, 500), command: step.command === null ? null : safeText(step.command, 500) }));
  result.instructions = result.steps.map(step => ({ ...step }));
  return { eligible: true, availability: "available", stale: false, sourceRevision: source, projectDirectory: result.directory, expectedUrl: result.url, prerequisites: result.prerequisites, limitations: result.limitations, verified: true, commit: source, branch: safeText(pass.branch, 200), ...result };
}
module.exports = { previewForLine, instructionFor, safeText };
