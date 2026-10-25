"use strict";

// Failure reporting for harness child processes (planner and workers, every
// harness). Two sources describe a failed run:
// - the harness's own error events on stdout, collected by the adapter
//   (adapter.errorText()): the most precise reason when present;
// - stderr, where CLIs print argument, startup, and crash errors.
// describeFailure() turns both plus the exit state into one readable
// message for the UI, the logs, and the planner wake prompts.

const STDERR_HEAD = 1000;
const STDERR_TAIL = 1000;

// Keeps both ends of a child's stderr. CLIs print the error first, and an
// echoed argument (e.g. a rejected 11k-character prompt) would push it out
// of a tail-only buffer.
class StderrCapture {
  constructor() {
    this.head = "";
    this.tail = "";
    this.length = 0;
  }

  push(chunk) {
    const c = String(chunk);
    this.length += c.length;
    if (this.head.length < STDERR_HEAD) this.head += c.slice(0, STDERR_HEAD - this.head.length);
    this.tail = (this.tail + c).slice(-STDERR_TAIL);
  }

  text() {
    const s = this.length <= STDERR_HEAD ? this.head
      : `${this.head.slice(0, 600)}\n…\n${this.tail.slice(-300)}`;
    return s.trim();
  }
}

// One line saying how the process ended.
function failureHeadline({ cmd, code, signal, outcome, spawnError }) {
  if (spawnError) {
    return spawnError.code === "ENOENT"
      ? `${cmd} could not start: command not found on PATH`
      : `${cmd} could not start: ${spawnError.message || spawnError.code || "unknown error"}`;
  }
  if (outcome === "timeout") return `${cmd} hit the run time limit`;
  if (signal) return `${cmd} was terminated by ${signal}`;
  if (code === 0) return `${cmd} reported an error`;
  return `${cmd} exited with code ${code}`;
}

// The full failure message: the headline, then the harness-reported error,
// then stderr when it adds anything. Returns the headline alone when the
// child left no detail.
function describeFailure({ cmd, code, signal, outcome, spawnError, streamError, stderr }) {
  const headline = failureHeadline({ cmd, code, signal, outcome, spawnError });
  const reported = typeof streamError === "string" ? streamError.trim() : "";
  const err = typeof stderr === "string" ? stderr.trim() : "";
  const parts = [];
  if (reported) parts.push(reported);
  if (err && err !== reported) parts.push(reported ? `stderr:\n${err}` : err);
  return parts.length ? `${headline}:\n${parts.join("\n\n")}` : headline;
}

module.exports = { StderrCapture, describeFailure };
