"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { StderrCapture, describeFailure } = require("../run-failure");
const { createHarness } = require("../harness");

// ---- StderrCapture ----

test("StderrCapture returns short stderr whole", () => {
  const c = new StderrCapture();
  c.push("error: bad flag\n");
  c.push("usage: x\n");
  assert.equal(c.text(), "error: bad flag\nusage: x");
});

test("StderrCapture keeps the head when an echoed prompt floods stderr", () => {
  const c = new StderrCapture();
  c.push("error: unknown option '--- PLANNER TURN CONTEXT ---\n");
  for (let i = 0; i < 200; i++) c.push("rule text that the CLI echoed back\n");
  c.push("- Do not use idioms.'\n");
  const text = c.text();
  assert.ok(text.startsWith("error: unknown option"), text.slice(0, 80));
  assert.ok(text.endsWith("- Do not use idioms.'"));
  assert.ok(text.includes("\n…\n"));
  assert.ok(text.length < 1000);
});

// ---- describeFailure ----

test("describeFailure names the cause of the exit", () => {
  const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
  assert.equal(describeFailure({ cmd: "claude", code: -2, spawnError: enoent }),
    "claude could not start: command not found on PATH");
  assert.equal(describeFailure({ cmd: "pi", code: null, signal: "SIGTERM", outcome: "timeout" }),
    "pi hit the run time limit");
  assert.equal(describeFailure({ cmd: "vibe", code: null, signal: "SIGKILL", outcome: "fail" }),
    "vibe was terminated by SIGKILL");
  assert.equal(describeFailure({ cmd: "codex", code: 2, outcome: "fail" }),
    "codex exited with code 2");
});

test("describeFailure puts the harness error first, then stderr", () => {
  assert.equal(describeFailure({ cmd: "claude", code: 1, outcome: "fail",
    streamError: "There's an issue with the selected model.",
    stderr: "[claude-code:unrecognized_model]" }),
  "claude exited with code 1:\nThere's an issue with the selected model.\n\nstderr:\n[claude-code:unrecognized_model]");
  assert.equal(describeFailure({ cmd: "pi", code: 1, outcome: "fail",
    stderr: "Error: Model \"x\" not found." }),
  "pi exited with code 1:\nError: Model \"x\" not found.");
  // Identical stderr is not repeated.
  assert.equal(describeFailure({ cmd: "pi", code: 1, outcome: "fail",
    streamError: "boom", stderr: "boom" }), "pi exited with code 1:\nboom");
});

// ---- adapter stream errors ----

test("claude API error message is recorded, never passed on as assistant text", () => {
  const h = createHarness("claude");
  const text = "There's an issue with the selected model (bogus). Run --model to pick a different model.";
  const entry = h.normalize({ type: "assistant", session_id: "s1", error: "model_not_found",
    is_api_error_message: true, api_error_status: 404,
    message: { role: "assistant", content: [{ type: "text", text }] } });
  assert.equal(entry, null);
  assert.equal(h.sessionId, "s1");
  h.normalize({ type: "result", subtype: "success", is_error: true, result: text });
  assert.equal(h.errorText(), text);
  assert.equal(h.outcome(1, null), "fail");
});

test("claude result with is_error fails the run even on exit code 0", () => {
  const h = createHarness("claude");
  h.normalize({ type: "result", subtype: "error_during_execution", is_error: true,
    errors: ["tool crashed", 7] });
  assert.equal(h.errorText(), "tool crashed");
  assert.equal(h.outcome(0, null), "fail");
  const ok = createHarness("claude");
  ok.normalize({ type: "result", subtype: "success", is_error: false, result: "done" });
  assert.equal(ok.errorText(), null);
  assert.equal(ok.outcome(0, null), "ok");
});

test("pi message_end with stopReason error is recorded", () => {
  const h = createHarness("pi");
  assert.equal(h.normalize({ type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limited" } }), null);
  h.normalize({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error" } });
  assert.equal(h.errorText(), "429 rate limited\npi reported an error without a message");
});

test("codex error and turn.failed events are recorded", () => {
  const h = createHarness("codex");
  h.normalize({ type: "error", message: "stream disconnected" });
  h.normalize({ type: "turn.failed", error: { message: "usage limit reached" } });
  assert.equal(h.errorText(), "stream disconnected\nusage limit reached");
});

test("adapters without stream errors report none", () => {
  for (const id of ["vibe", "pi", "codex", "claude"]) {
    assert.equal(createHarness(id).errorText(), null, id);
  }
});
