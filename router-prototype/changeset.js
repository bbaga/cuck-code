"use strict";

// Change-set limit for implementors: pure helpers that parse
// `git diff --numstat` output, compute deterministic per-file totals, and
// evaluate the 500-line limit against a base commit. server.js calls
// collectChangeset with the real git binary; the unit tests inject a fake
// run function, so no git process is needed to test the logic.

const { spawnSync } = require("node:child_process");

const CHANGESET_LIMIT = 500;

// Parse one numstat line: "additions\tdeletions\tpath". A "-" in the
// additions or deletions column marks a binary file. Returns null for a
// line that cannot be parsed.
function parseNumstatLine(line) {
  if (typeof line !== "string") return null;
  const parts = line.split("\t");
  if (parts.length < 3) return null;
  const path = parts.slice(2).join("\t");
  if (!path.trim()) return null;
  const [add, del] = parts;
  if (add === "-" || del === "-") {
    return { path, binary: true, additions: 0, deletions: 0 };
  }
  if (!/^\d+$/.test(add) || !/^\d+$/.test(del)) return null;
  return { path, binary: false, additions: Number(add), deletions: Number(del) };
}

// Parse full numstat output into a list of per-file rows.
function parseNumstat(output) {
  return String(output == null ? "" : output).split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim().length > 0)
    .map(parseNumstatLine)
    .filter(Boolean);
}

// Deterministic per-file totals: files sorted by path, additions plus
// deletions summed over all rows.
function summarizeChanges(rows) {
  const files = (Array.isArray(rows) ? rows : [])
    .map((r) => ({ path: r.path, additions: r.additions,
      deletions: r.deletions, binary: !!r.binary }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  return { additions, deletions, total: additions + deletions, files };
}

function runWith(worktreePath, run) {
  return run || ((args) => {
    const r = spawnSync("git", ["-C", worktreePath, ...args], { encoding: "utf8" });
    return { status: r.status, stdout: r.stdout || "" };
  });
}

function uncountable(baseCommit, limit, error) {
  return { ok: false, reason: "uncountable", error, limit,
    baseCommit: baseCommit || null, headCommit: null,
    additions: 0, deletions: 0, total: 0, files: [],
    binaryPaths: [], dirtyPaths: [], untrackedPaths: [] };
}

// Collect and evaluate the change set of an implementor worktree against
// its base commit. opts.run injects a fake git runner
// ((args) => { status, stdout }) for tests; opts.limit overrides the
// default limit. Binary, dirty, or untracked work cannot enter validation.
function collectChangeset(worktreePath, baseCommit, opts = {}) {
  const run = runWith(worktreePath, opts.run);
  const limit = Number.isInteger(opts.limit) ? opts.limit : CHANGESET_LIMIT;
  if (!baseCommit) return uncountable(baseCommit, limit, "no base commit");
  const head = run(["rev-parse", "HEAD"]);
  if (head.status !== 0 || !head.stdout.trim()) {
    return uncountable(baseCommit, limit, "no head commit");
  }
  const headCommit = head.stdout.trim();
  const diff = run(["diff", "--numstat", baseCommit]);
  if (diff.status !== 0) return uncountable(baseCommit, limit, "git diff failed");
  const summary = summarizeChanges(parseNumstat(diff.stdout));
  const status = run(["status", "--porcelain"]);
  if (status.status !== 0) return uncountable(baseCommit, limit, "git status failed");
  const dirtyPaths = [];
  const untrackedPaths = [];
  for (const line of status.stdout.split("\n")) {
    if (!line.trim()) continue;
    const path = line.slice(3);
    if (line.startsWith("??")) untrackedPaths.push(path);
    else dirtyPaths.push(path);
  }
  const binaryPaths = summary.files.filter((f) => f.binary).map((f) => f.path);
  let reason = null;
  if (binaryPaths.length) reason = "binary";
  else if (dirtyPaths.length) reason = "dirty";
  else if (untrackedPaths.length) reason = "untracked";
  else if (summary.total > limit) reason = "oversized";
  return { ok: reason === null, reason, limit, baseCommit, headCommit,
    additions: summary.additions, deletions: summary.deletions,
    total: summary.total, files: summary.files,
    binaryPaths, dirtyPaths, untrackedPaths };
}

// The planner wake message for a change set that cannot enter validation.
function changesetWakeMessage(cs, worker) {
  const perFile = cs.files.length
    ? cs.files.map((f) => `${f.path}: +${f.additions}/-${f.deletions}${f.binary ? " (binary)" : ""}`).join("; ")
    : "none";
  return `CHANGESET LIMIT EXCEEDED - implementor '${worker.name}' (workerId ${worker.id}, `
    + `session ${worker.sessionId || "unknown"}, branch ${worker.branch}) produced a change set `
    + `that cannot enter validation (reason: ${cs.reason}). `
    + `Base commit ${cs.baseCommit || "unknown"}, head commit ${cs.headCommit || "unknown"}. `
    + `Additions ${cs.additions}, deletions ${cs.deletions}, total ${cs.total}, limit ${cs.limit}. `
    + `Binary paths: ${(cs.binaryPaths || []).join(", ") || "none"}. `
    + `Dirty paths: ${(cs.dirtyPaths || []).join(", ") || "none"}. `
    + `Untracked paths: ${(cs.untrackedPaths || []).join(", ") || "none"}. `
    + `Per file: ${perFile}. `
    + `The worker session and worktree are preserved. Send follow-up instructions with `
    + `POST /api/protocol/workers/${worker.id}/continue to bring the change set within the limit.`;
}

// The persisted and API-visible change-set fields of a worker record.
function changesetFields(worker) {
  return { baseCommit: worker.baseCommit || null, changeset: worker.changeset || null };
}

module.exports = {
  CHANGESET_LIMIT,
  parseNumstatLine,
  parseNumstat,
  summarizeChanges,
  collectChangeset,
  changesetWakeMessage,
  changesetFields,
};
