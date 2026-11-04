"use strict";

// Review-size policy for implementors: pure helpers that parse
// `git diff --numstat` output, compute per-file totals, and evaluate the
// change set against the review-size target. Tests inject a fake git runner
// via opts.run.
//
// Two different outcomes:
// - A safety blocker (binary, dirty, untracked, uncountable) sets ok to
//   false with a reason. The work cannot enter validation.
// - A total over the review-size target is only a warning: ok stays true,
//   oversized is true. The work can enter independent review with the
//   size warning; the router never rejects it for the count alone.

const { spawnSync } = require("node:child_process");

// The strongly preferred review-size target: additions plus deletions.
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
  // Binary only when BOTH columns are dashes; one dash is malformed.
  if (add === "-" && del === "-") {
    return { path, binary: true, additions: 0, deletions: 0 };
  }
  if (!/^\d+$/.test(add) || !/^\d+$/.test(del)) return null;
  return { path, binary: false, additions: Number(add), deletions: Number(del) };
}

// Parse full numstat output into { rows, errors }. errors holds the raw
// malformed non-empty lines: any malformed row is uncountable.
function parseNumstat(output) {
  const rows = [];
  const errors = [];
  for (const line of String(output == null ? "" : output).split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.trim().length) continue;
    const row = parseNumstatLine(trimmed);
    if (row) rows.push(row);
    else errors.push(trimmed);
  }
  return { rows, errors };
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

function uncountable(baseCommit, limit, error, parseErrors = [], headCommit = null) {
  return { ok: false, reason: "uncountable", oversized: false, error, limit,
    parseErrors, baseCommit: baseCommit || null, headCommit: headCommit || null,
    additions: 0, deletions: 0, total: 0, files: [],
    binaryPaths: [], dirtyPaths: [], untrackedPaths: [] };
}

// Collect and evaluate the change set of an implementor worktree against
// its base commit. opts.run injects a fake git runner for tests; opts.limit
// overrides the default target. Binary, dirty, or untracked work is a
// safety blocker; a total over the target is only an oversize warning.
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
  if (diff.status !== 0) {
    return uncountable(baseCommit, limit, "git diff failed", [], headCommit);
  }
  const { rows, errors } = parseNumstat(diff.stdout);
  // Any malformed row is uncountable; only the offending lines are
  // reported, and the resolved HEAD stays in the result.
  if (errors.length) {
    return uncountable(baseCommit, limit, "malformed numstat output", errors, headCommit);
  }
  const summary = summarizeChanges(rows);
  const status = run(["status", "--porcelain"]);
  if (status.status !== 0) {
    return uncountable(baseCommit, limit, "git status failed", [], headCommit);
  }
  const dirtyPaths = [];
  const untrackedPaths = [];
  for (const line of status.stdout.split("\n")) {
    if (!line.trim()) continue;
    const path = line.slice(3);
    if (line.startsWith("??")) untrackedPaths.push(path);
    else dirtyPaths.push(path);
  }
  const binaryPaths = summary.files.filter((f) => f.binary).map((f) => f.path);
  const oversized = summary.total > limit;
  let reason = null;
  if (binaryPaths.length) reason = "binary";
  else if (dirtyPaths.length) reason = "dirty";
  else if (untrackedPaths.length) reason = "untracked";
  // Oversize is a review signal, never a safety failure: ok stays true so
  // an oversized but otherwise valid change can enter independent review.
  return { ok: reason === null, reason, oversized, limit, baseCommit, headCommit,
    additions: summary.additions, deletions: summary.deletions,
    total: summary.total, files: summary.files,
    warning: oversized
      ? `review-size target exceeded: total ${summary.total} > target ${limit}`
      : null,
    binaryPaths, dirtyPaths, untrackedPaths };
}

// The feedback interaction of a worker: the one way the planner sends
// follow-up instructions to the original implementor session.
function feedbackNote(worker) {
  return `Send follow-up instructions to the ORIGINAL session with the feedback interaction: `
    + `POST /api/protocol/lines/${worker.lineId || "<lineId>"}/interactions/feedback `
    + `with {"instance":"${worker.id}","instructions":"..."}.`;
}

// The planner wake message for a change set that cannot enter validation:
// a safety blocker (binary, dirty, untracked, or uncountable work).
function changesetWakeMessage(cs, worker) {
  const perFile = cs.files.length
    ? cs.files.map((f) => `${f.path}: +${f.additions}/-${f.deletions}${f.binary ? " (binary)" : ""}`).join("; ")
    : "none";
  return `CHANGESET BLOCKED - implementor '${worker.name}' (workerId ${worker.id}, `
    + `session ${worker.sessionId || "unknown"}, branch ${worker.branch}) produced a change set `
    + `that cannot enter validation (reason: ${cs.reason}). `
    + `Error: ${cs.error || "none"}. `
    + `Malformed lines: ${(cs.parseErrors || []).join(" | ") || "none"}. `
    + `Base commit ${cs.baseCommit || "unknown"}, head commit ${cs.headCommit || "unknown"}. `
    + `Additions ${cs.additions}, deletions ${cs.deletions}, total ${cs.total}, target ${cs.limit}. `
    + `Binary paths: ${(cs.binaryPaths || []).join(", ") || "none"}. `
    + `Dirty paths: ${(cs.dirtyPaths || []).join(", ") || "none"}. `
    + `Untracked paths: ${(cs.untrackedPaths || []).join(", ") || "none"}. `
    + `Per file: ${perFile}. `
    + `The worker session and worktree are preserved. ${feedbackNote(worker)}`;
}

// The planner wake message for an oversized but otherwise valid change set:
// the work can enter independent review; the planner decides between
// accepting the size and a real split. Never ask for line compression.
function changesetOversizeMessage(cs, worker) {
  const perFile = cs.files.length
    ? cs.files.map((f) => `${f.path}: +${f.additions}/-${f.deletions}`).join("; ")
    : "none";
  return `CHANGESET OVERSIZE WARNING - implementor '${worker.name}' (workerId ${worker.id}, `
    + `session ${worker.sessionId || "unknown"}, branch ${worker.branch}) went over the `
    + `review-size target, but the change set is valid and can enter independent review. `
    + `Base commit ${cs.baseCommit || "unknown"}, head commit ${cs.headCommit || "unknown"}. `
    + `Additions ${cs.additions}, deletions ${cs.deletions}, total ${cs.total}, target ${cs.limit}. `
    + `Per file: ${perFile}. `
    + `Read the implementor rationale in its report. Decide: accept the size with a reason, `
    + `or send feedback that splits the work into coherent, independently testable parts `
    + `in dependency order. Do not ask the implementor to minify code or to remove tests `
    + `or explanations to pass the count. ${feedbackNote(worker)}`;
}

// The size warning for the validator prompt: the exact size, the base and
// head commits, and the per-file counts, so the validator can judge
// reviewability with the numbers in view. Null when the change set is
// within the target. The implementor rationale stays in the report; the
// warning never replaces it.
function changesetValidatorWarning(cs) {
  if (!cs || !cs.oversized) return null;
  const perFile = cs.files.length
    ? cs.files.map((f) => `${f.path}: +${f.additions}/-${f.deletions}`).join("; ")
    : "none";
  return `The change set of the implementor is over the review-size target: `
    + `total ${cs.total} > target ${cs.limit}. `
    + `Base commit ${cs.baseCommit || "unknown"}, head commit ${cs.headCommit || "unknown"}. `
    + `Per file: ${perFile}. `
    + `Judge reviewability, not the count alone.`;
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
  changesetOversizeMessage,
  changesetValidatorWarning,
  changesetFields,
};
