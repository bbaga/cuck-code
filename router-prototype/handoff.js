"use strict";

function messageText(entry) {
  if (!entry || typeof entry !== "object") return "";
  if (typeof entry.text === "string") return entry.text;
  const content = entry.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function assistantText(entry) {
  return entry && entry.type === "message" && entry.role === "assistant"
    ? messageText(entry)
    : "";
}

function collectAssistantText(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map(assistantText)
    .filter((text) => text.length > 0)
    .join("\n");
}

function appendTranscript(transcript, entry, limit = 500) {
  transcript.push(entry);
  while (transcript.length > limit) transcript.shift();
}

class InvocationCapture {
  constructor() {
    this.entries = [];
  }

  add(entry) {
    this.entries.push(entry);
  }

  text() {
    return collectAssistantText(this.entries);
  }
}

function reportForValidation(_worker, sourceReport) {
  const report = typeof sourceReport === "string" ? sourceReport : "";
  return report || "[No assistant implementor report text was produced by this run.]";
}

function explicitVerdict(report) {
  if (typeof report !== "string") return null;
  const lines = report.split(/\r?\n/);
  const quotedOrFenced = new Set();
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      quotedOrFenced.add(i);
      inFence = !inFence;
      continue;
    }
    if (inFence || /^\s*>/.test(line)) quotedOrFenced.add(i);
  }
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last -= 1;
  if (last < 0 || quotedOrFenced.has(last)) return null;
  const match = lines[last].match(/^VERDICT:\s*(PASS|FAIL)\s*$/);
  return match ? match[1].toLowerCase() : null;
}

function applyCompletion(worker, outcome, stopRequested, report) {
  const state = completionState(worker, outcome, stopRequested, report);
  worker.status = state.status;
  worker.verdict = state.verdict;
  worker.lastRunText = report;
  return workerStatusEvent(worker);
}

function completionFields(worker) {
  return { status: worker.status, verdict: worker.verdict || null };
}

function workerStatusEvent(worker) {
  return { workerId: worker.id, ...completionFields(worker) };
}

function completionState(worker, outcome, stopRequested, report) {
  let status;
  if (stopRequested) status = "stopped";
  else if (outcome === "ok") status = "completed";
  else if (outcome === "timeout") status = "stopped";
  else status = "failed";
  const verdict = worker.role === "validator" && status === "completed"
    ? explicitVerdict(report)
    : null;
  return { status, verdict };
}

function reportBody(report, label = "assistant report") {
  return typeof report === "string" && report.length > 0
    ? report
    : `[No ${label} text was produced by this run.]`;
}

function runOutputNote(report, label = "assistant run output") {
  return `\n\nRUN OUTPUT (complete):\n${reportBody(report, label)}`;
}

// The notice for a finished worker whose node is not in the line graph: no
// report interaction can render it, so this one text covers every kind of
// worker. It names the actions the planner has left.
function buildUnroutedNotification(worker, source, report) {
  const kind = worker.kind === "integration" ? "integration validator"
    : worker.role === "validator" ? "validator" : "implementor";
  const verdictNote = worker.role !== "validator" ? ""
    : worker.verdict
      ? `\n\nFINAL VERDICT: ${worker.verdict.toUpperCase()}.`
      : "\n\nDIAGNOSTIC: no explicit final VERDICT: PASS or VERDICT: FAIL line was found, or this run did not complete successfully.";
  const checks = worker.role === "validator" && worker.kind !== "integration"
    ? ` It checked implementor '${source ? source.name : "unknown"}' (workerId ${worker.validates || "unknown"}).` : "";
  return `WORKER REPORT - ${kind} '${worker.name}' (workerId ${worker.id}, ${worker.harness || "vibe"} session ${worker.sessionId || "unknown"}, branch ${worker.branch}) finished.${checks} Its node '${worker.node || "unknown"}' is not in the pipeline graph of this line, so the router applied no report interaction.\n\nREPORT BODY (complete):\n${reportBody(report)}${verdictNote}\n\nCheck the instance and decide how to proceed: call start on a validator node, call accept, or send feedback to the implementor.`;
}

module.exports = {
  messageText,
  assistantText,
  collectAssistantText,
  InvocationCapture,
  appendTranscript,
  reportForValidation,
  explicitVerdict,
  completionState,
  applyCompletion,
  completionFields,
  workerStatusEvent,
  reportBody,
  runOutputNote,
  buildUnroutedNotification,
};
