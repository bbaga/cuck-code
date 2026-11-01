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
    const guidance = [...steps, { phase: "prepare", description: "Identify the application directory and package manager from the validated source before continuing.", expected: "Select one unambiguous application directory and supported lockfile.", command: null }, { phase: "verify", description: "What to verify: run the changed code in its intended context and compare its observable result with the requested behavior.", expected: "The expected behavior needs confirmation because the validated source does not identify an application or acceptance checks.", command: null }];
    return { stack: "unknown", directory, url: null, packageManager: null, steps: guidance, prerequisites: ["Confirm required runtime and environment values; none can be determined safely from the validated files."], limitations: ["The application directory or package manager is ambiguous. No project-specific acceptance checks can be derived safely."], instructions: guidance };
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
  const scripts = pkg.scripts || {};
  const runScript = stack === "unknown" ? null : Object.hasOwn(scripts, "start") ? "start" : Object.hasOwn(scripts, "dev") ? "dev" : null;
  const scriptCommand = runScript ? `${manager} run ${runScript}` : null;
  const verificationFiles = ["README.md", "CONTRIBUTING.md", "TESTING.md", "docs/testing.md", "docs/verification.md"].filter(has);
  const verificationText = verificationFiles.map(file => read(relative ? `${relative}/${file}` : file) || "").join("\n");
  const urls = [...verificationText.matchAll(/https?:\/\/localhost(?::\d+)?(?:\/[^\s)`]*)?/gi)].map(match => match[0].replace(/[.,;:]$/, ""));
  const ports = [...verificationText.matchAll(/(?:port|localhost:)\s*(\d{2,5})/gi)].map(match => Number(match[1])).filter(port => port > 0 && port <= 65535);
  const uniquePorts = [...new Set(ports)];
  const url = urls.length && urls.every(candidate => candidate === urls[0]) ? urls[0] : null;
  const verifiedPort = !url && uniquePorts.length === 1 ? uniquePorts[0] : null;
  const limitations = [];
  if (!manager) limitations.push(managers.length ? "Multiple package manager lockfiles exist; the intended manager is unknown." : "No supported package manager lockfile exists; the package manager is unknown.");
  if (!runScript) limitations.push("No supported application start script can be identified safely.");
  if (!url && !verifiedPort) limitations.push("No unambiguous verification URL or port is recorded in the validated documentation. Read the URL printed by the application.");
  const runnable = !!cloneUrl && !!manager && !!scriptCommand;
  const noRepoInfo = "No safe repository URL is available. Obtain the repository and validated revision manually before using local commands.";
  const phases = [];
  phases.push({ phase: "prepare", description: `Prerequisites: confirm the required runtime version and any environment values from ${verificationFiles.length ? verificationFiles.join(", ") : "the project owner"}. The validated source does not identify secret values.`, expected: "Required tools and user-provided environment values are available; do not guess secrets.", command: null });
  phases.push({ phase: "obtain", description: cloneUrl ? steps[0].description : noRepoInfo, expected: cloneUrl ? `A checkout at validated commit ${sha} exists.` : "Obtain the exact validated revision before running setup commands.", command: cloneUrl ? steps[0].command : null });
  const checkoutPrefix = cloneUrl ? `${target}/${directory === "." ? "" : `${directory}/`}` : null;
  phases.push({ phase: "enter", description: `Application directory: ${directory}. The install and launch commands below include their own directory change.`, expected: cloneUrl ? `Use ${checkoutPrefix} within the checkout at the validated revision.` : "Confirm the application directory in the manually obtained validated revision.", command: null });
  if (manager && cloneUrl) phases.push({ phase: "install", description: `Install dependencies from the application directory ${directory}. This command changes to that directory itself.`, expected: "The locked dependencies install without errors.", command: `cd ${shellQuote(checkoutPrefix)} && ${manager === "npm" ? "npm ci" : manager === "yarn" ? "yarn install --frozen-lockfile" : manager === "pnpm" ? "pnpm install --frozen-lockfile" : "bun install --frozen-lockfile"}` });
  else phases.push({ phase: "install", description: "Install dependencies only after identifying the application directory and one supported package manager.", expected: "The intended locked dependencies install without errors.", command: null });
  if (runnable && cloneUrl) phases.push({ phase: "run", description: `Start the validated ${stack} application script (${runScript}) from its application directory.`, expected: url ? `The application starts and serves ${url}.` : verifiedPort ? `The application starts on the documented port ${verifiedPort}; open http://localhost:${verifiedPort} if the app does not print another URL.` : "The application starts and prints a local URL. Use that exact printed URL; no port is inferred.", command: `cd ${shellQuote(checkoutPrefix)} && ${scriptCommand}` });
  else phases.push({ phase: "run", description: "Start the application only after confirming its supported script and required environment values in the validated source.", expected: "The application starts and reports its local URL.", command: null });
  const changedFiles = git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]) || "";
  const safeChanged = changedFiles.split("\n").filter(file => file && !file.startsWith(".") && !file.includes("..") && /^[A-Za-z0-9_./-]+$/.test(file));
  const verification = verificationText.match(/(?:^|\n)\s*(?:[-*]|\d+\.)\s+[^\n]{8,}/g) || [];
  const checks = verification.slice(0, 5).map(item => item.trim().replace(/^[-*\d. ]+/, ""));
  const verifyDetails = checks.length ? `Use these project-recorded checks: ${checks.join("; ")}.` : safeChanged.length ? `What to verify: exercise the changed paths ${safeChanged.slice(0, 8).join(", ")} through the running application or its documented user workflow. Observe the relevant output or state before and after the change.` : "What to verify: exercise the changed behavior through the running application's user workflow. Observe the relevant output or state before and after the change.";
  phases.push({ phase: "verify", description: `${verifyDetails} Check normal input and one relevant boundary or invalid input. Compare the user-visible result with the expected behavior described by the change request.`, expected: "The behavior matches the intended change and no visible error occurs. Project-specific acceptance criteria are not present in the validated source and require user confirmation.", command: null });
  phases.push({ phase: "stop", description: "Stop the foreground application process in the terminal where it is running.", expected: "The application process exits.", command: null });
  if (!runnable || !cloneUrl) limitations.push("Some or all executable setup and launch commands are unavailable; confirm the missing URL, package manager, start script, or environment requirements before continuing.");
  const guidance = phases.map(step => ({ phase: step.phase, description: step.description, expected: step.expected, command: step.command }));
  return { stack, directory, url, packageManager: manager, steps: guidance, prerequisites: ["Required runtime version: unknown unless validated documentation states it.", "Required environment variable names and values: unknown unless recorded in validated files; never invent or expose secrets."], limitations, instructions: guidance };
}
function previewForLine(line) {
  const pass = [...line.workers.values()].find(w => w.kind === "integration" && w.role === "validator" && w.status === "completed" && w.verdict === "pass");
  const base = { eligible: false, availability: "unavailable", stale: false, sourceRevision: null, projectDirectory: null, expectedUrl: null, prerequisites: [], limitations: [] };
  if (!pass) return { ...base, reason: "No completed integration result has a PASS verdict." };
  // An integration records one worktree per repository. A preview needs exactly one.
  const manifest = pass.integration && Array.isArray(pass.integration.repos) ? pass.integration.repos : null;
  if (manifest && manifest.length !== 1) return { ...base, eligible: true, reason: "The integration spans several repositories. A preview supports one repository only." };
  const single = manifest ? manifest[0] : null;
  const source = single ? single.validatedCommit : pass.validatedCommit || pass.sourceRevision || pass.integrationCommit;
  if (!source || !/^[a-f0-9]{40}$/i.test(source)) return { ...base, eligible: true, stale: true, reason: "The validated commit was not recorded; source is unavailable or unverified." };
  const workdir = path.resolve((single ? single.worktreePath : pass.worktreePath) || "");
  if (!fs.existsSync(workdir) || git(workdir, ["cat-file", "-e", `${source}^{commit}`]) === null) return { ...base, eligible: true, stale: true, reason: "The recorded validated source is unavailable." };
  const lineUrls = line.repos instanceof Map ? [...line.repos.values()].map(r => r && r.url).filter(Boolean) : [];
  const repos = single ? [single.url].filter(Boolean) : [...lineUrls, pass.repoUrl].filter(Boolean);
  const configuredUrl = repos.length === 1 ? repos[0] : null;
  const result = instructionFor(workdir, source, configuredUrl);
  result.steps = result.steps.map(step => ({ ...step, description: safeText(step.description, 500), expected: safeText(step.expected, 500), command: step.command === null ? null : safeText(step.command, 500) }));
  result.instructions = result.steps.map(step => ({ ...step }));
  return { eligible: true, availability: "available", stale: false, sourceRevision: source, projectDirectory: result.directory, expectedUrl: result.url, prerequisites: result.prerequisites, limitations: result.limitations, verified: true, commit: source, branch: safeText(pass.branch, 200), ...result };
}
module.exports = { previewForLine, instructionFor, safeText };
