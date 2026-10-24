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

function isSkipValidation(criteria) {
  return typeof criteria === "string"
    && criteria.trim().toUpperCase().startsWith("SKIP VALIDATION");
}

function hasCriteria(criteria) {
  return typeof criteria === "string" && criteria.trim().length > 0;
}

function validationCriteriaBlock(criteria) {
  return `The planner gave these acceptance criteria:\n${criteria}`;
}

function pendingValidationFor(source, criteria) {
  return { implWorkerId: source.workerId, invocationId: source.invocationId,
    runId: source.runId, report: source.report, criteria };
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

function missingCriteriaDiagnostic(workerName) {
  return `VALIDATION NOT STARTED - no assistant acceptance criteria were returned by the current planner run for implementor '${workerName}'. No old transcript text was used. Reply with numbered criteria only, or SKIP VALIDATION.`;
}

function reportBody(report, label = "assistant report") {
  return typeof report === "string" && report.length > 0
    ? report
    : `[No ${label} text was produced by this run.]`;
}

function runOutputNote(report, label = "assistant run output") {
  return `\n\nRUN OUTPUT (complete):\n${reportBody(report, label)}`;
}

function buildImplementorNotification(worker, report) {
  return `IMPLEMENTOR REPORT - '${worker.name}' (workerId ${worker.id}, ${worker.harness || "vibe"} session ${worker.sessionId || "unknown"}, branch ${worker.branch}) finished.\n\nREPORT BODY (complete):\n${reportBody(report)}\n\nNow give the acceptance criteria for the validation of this work.\nReply with a numbered list of criteria only. Use the imperative. If\nthe work needs no validation, reply with SKIP VALIDATION.`;
}

function buildValidationNotification(worker, impl, report) {
  const implName = impl ? impl.name : "unknown";
  const implId = worker.validates || "unknown";
  const implSession = impl ? (impl.sessionId || "unknown") : "unknown";
  const verdictNote = worker.verdict
    ? `\n\nFINAL VERDICT: ${worker.verdict.toUpperCase()}.`
    : "\n\nDIAGNOSTIC: no explicit final VERDICT: PASS or VERDICT: FAIL line was found, or this run did not complete successfully.";
  return `VALIDATION REPORT - validator '${worker.name}' checked the work of implementor '${implName}' (workerId ${implId}, ${(impl && impl.harness) || "vibe"} session ${implSession}, branch ${worker.branch}).\n\nREPORT BODY (complete):\n${reportBody(report, "validation report")}${verdictNote}\n\nDecide: accept the work, send follow-up instructions to the original implementor (POST /api/protocol/workers/${implId}/continue with {"prompt": ...}), or spawn a new implementor with a corrected prompt.`;
}

function buildIntegrationNotification(worker, report) {
  const verdictNote = worker.verdict
    ? `\n\nFINAL VERDICT: ${worker.verdict.toUpperCase()}.`
    : "\n\nDIAGNOSTIC: no explicit final VERDICT: PASS or VERDICT: FAIL line was found, or this run did not complete successfully.";
  return `INTEGRATION REPORT - integration validator '${worker.name}' finished. The merged result is on branch ${worker.branch} in its worktree; main/master is untouched.\n\nREPORT BODY (complete):\n${reportBody(report, "integration report")}${verdictNote}\n\nDecide: report completion to the user, or route fixes to the ORIGINAL implementors (continue endpoint) and start a new integration validator after they pass again.`;
}

module.exports = {
  messageText,
  assistantText,
  collectAssistantText,
  InvocationCapture,
  appendTranscript,
  isSkipValidation,
  hasCriteria,
  validationCriteriaBlock,
  pendingValidationFor,
  reportForValidation,
  explicitVerdict,
  completionState,
  applyCompletion,
  completionFields,
  workerStatusEvent,
  reportBody,
  runOutputNote,
  missingCriteriaDiagnostic,
  buildImplementorNotification,
  buildValidationNotification,
  buildIntegrationNotification,
};
