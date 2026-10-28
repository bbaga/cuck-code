"use strict";

// Context compaction: pure helpers for keeping long-lived harness sessions
// small. The router compacts a session in two steps that work the same on
// every harness:
//   1. A summary turn on the existing session asks the agent for a handoff
//      summary of everything a fresh session needs to continue.
//   2. The router drops the session id. The next run starts a fresh session
//      and its prompt carries the role brief plus the handoff summary.
//
// Context size per session is the latest token count the harness reports:
// on its stream (claude, pi; see harness.js) or in its session files (vibe,
// codex; see context-probe.js). Without one it falls back to a character
// estimate of the prompts and assistant output. The estimate excludes tool
// output, so it is a lower bound.

const CHARS_PER_TOKEN = 4;
const DEFAULT_AUTO_TOKENS = 150000;

// A summary shorter than this is treated as a failed compaction: the old
// session stays in use.
const MIN_SUMMARY_CHARS = 40;

function newContextStats() {
  return { tokens: null, chars: 0, turns: 0, compactions: 0, autoFailed: false };
}

function restoreContextStats(raw) {
  const stats = newContextStats();
  if (!raw || typeof raw !== "object") return stats;
  if (Number.isFinite(raw.tokens) && raw.tokens >= 0) stats.tokens = raw.tokens;
  if (Number.isFinite(raw.chars) && raw.chars >= 0) stats.chars = raw.chars;
  if (Number.isInteger(raw.turns) && raw.turns >= 0) stats.turns = raw.turns;
  if (Number.isInteger(raw.compactions) && raw.compactions >= 0) stats.compactions = raw.compactions;
  stats.autoFailed = raw.autoFailed === true;
  return stats;
}

// Record one completed run on the current session. tokens is the adapter's
// latest reported context size, or null when the harness reports none.
function recordTurn(stats, { promptChars = 0, outputChars = 0, tokens = null } = {}) {
  stats.chars += Math.max(0, promptChars) + Math.max(0, outputChars);
  stats.turns += 1;
  if (Number.isFinite(tokens) && tokens > 0) stats.tokens = tokens;
  return stats;
}

// Start the stats over for a fresh session. The compaction count survives.
function resetForFreshSession(stats) {
  const next = newContextStats();
  next.compactions = (stats ? stats.compactions : 0) + 1;
  return next;
}

function contextSize(stats) {
  if (!stats) return 0;
  if (Number.isFinite(stats.tokens) && stats.tokens > 0) return stats.tokens;
  return Math.ceil(stats.chars / CHARS_PER_TOKEN);
}

// The view sent to the dashboard.
function contextView(stats, threshold) {
  const s = stats || newContextStats();
  return { tokens: contextSize(s), estimated: !(Number.isFinite(s.tokens) && s.tokens > 0),
    turns: s.turns, compactions: s.compactions, threshold: threshold > 0 ? threshold : null };
}

// Auto compaction runs once the session passes the threshold. A failed
// auto compaction is not retried on the same session; manual compaction
// stays available.
function shouldAutoCompact(stats, threshold) {
  return threshold > 0 && !!stats && !stats.autoFailed && contextSize(stats) >= threshold;
}

// Parse the COMPACT_AUTO_TOKENS setting: unset uses the default, 0 turns
// auto compaction off, anything else must be a positive integer.
function parseAutoThreshold(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_AUTO_TOKENS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`COMPACT_AUTO_TOKENS must be a non-negative integer, got: ${value}`);
  }
  return n;
}

function compactionPrompt(role) {
  const subject = role === "planner"
    ? "the plan and its status, approval state, every worker you spawned (name, workerId, persona, repo, branch, status, last verdict), pending reports or validations, open decisions"
    : "the task, what you changed so far (files, commits, branch), how you verified it, the feedback you received, open issues";
  return `CONTEXT COMPACTION REQUEST from the router.
The router will continue your work in a fresh session that has none of this conversation. Do not use tools. Do not change files. Do not start new work.
Reply only with a handoff summary that the fresh session can act on. Include ${subject}, important file paths and identifiers, and the next step. Keep exact names, ids, and numbers. Leave out greetings and process narration. Keep it under 800 words.`;
}

function acceptSummary(text) {
  const summary = typeof text === "string" ? text.trim() : "";
  return summary.length >= MIN_SUMMARY_CHARS ? summary : null;
}

function handoffBlock(summary) {
  return `--- COMPACTED CONTEXT ---
The router compacted your earlier session. This is the handoff summary written at the end of that session. Treat it as your own memory of the work so far; files on disk and router state are authoritative when they differ.
${summary}
--- END COMPACTED CONTEXT ---`;
}

// The prompt for the first run of a fresh worker session: the original
// brief, the handoff summary, then the new instructions.
function workerReseedPrompt(brief, summary, prompt) {
  return `${brief}

${handoffBlock(summary)}

${prompt}`;
}

module.exports = {
  DEFAULT_AUTO_TOKENS, newContextStats, restoreContextStats, recordTurn, resetForFreshSession,
  contextSize, contextView, shouldAutoCompact, parseAutoThreshold, compactionPrompt,
  acceptSummary, handoffBlock, workerReseedPrompt,
};
