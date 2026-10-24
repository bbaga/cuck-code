"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHarness } = require("../harness");
const {
  messageText,
  collectAssistantText,
  InvocationCapture,
  appendTranscript,
  isSkipValidation,
  hasCriteria,
  validationCriteriaBlock,
  pendingValidationFor,
  reportForValidation,
  missingCriteriaDiagnostic,
  runOutputNote,
  explicitVerdict,
  applyCompletion,
  completionFields,
  buildImplementorNotification,
  buildValidationNotification,
  buildIntegrationNotification,
} = require("../handoff");

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", `${name}.jsonl`), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("chains real Pi stream output through normalized assistant text into exact criteria", () => {
  const pi = createHarness("pi");
  const records = [
    ...fixture("pi"),
    { type: "message_end", message: { role: "assistant", content: [
      { type: "text", text: "1. Check all paths.\n2. Keep Unicode ✓ and punctuation: !" },
    ] } },
  ];
  const output = new InvocationCapture();
  for (const record of records) {
    const entry = pi.normalize(record);
    if (entry) output.add(entry);
  }
  const finalized = pi.finalize();
  if (finalized) output.add(finalized);
  const criteria = output.text();
  assert.equal(criteria, "1. Check all paths.\n2. Keep Unicode ✓ and punctuation: !");
  assert.equal(validationCriteriaBlock(criteria),
    `The planner gave these acceptance criteria:\n${criteria}`);
});

test("chains a real Vibe adapter report into full notifications and final verdict state", () => {
  const vibe = createHarness("vibe");
  const normalized = fixture("vibe").map((record) => vibe.normalize(record)).filter(Boolean);
  normalized.push(vibe.normalize({ type: "message", role: "assistant", content: [
    { type: "text", text: "Implementor details ✓\nVERDICT: FAIL" },
  ] }));
  const run = new InvocationCapture();
  normalized.forEach((entry) => run.add(entry));
  const report = run.text();
  assert.equal(report, "Hello from vibe\nSecond part\nImplementor details ✓\nVERDICT: FAIL");
  const implementor = { id: "impl-3", name: "worker", harness: "vibe", sessionId: "s3", branch: "b3" };
  assert.ok(buildImplementorNotification(implementor, report).includes(
    `REPORT BODY (complete):\n${report}\n\nNow give`));

  const validator = { id: "validator-3", role: "validator", name: "validator-worker",
    validates: implementor.id, branch: "b3" };
  const event = applyCompletion(validator, "ok", false, report);
  assert.equal(validator.verdict, "fail");
  assert.deepEqual(event, { workerId: validator.id, status: "completed", verdict: "fail" });
  assert.ok(buildValidationNotification(validator, implementor, report).includes(
    `REPORT BODY (complete):\n${report}\n\nFINAL VERDICT: FAIL.`));
  assert.ok(buildIntegrationNotification({ ...validator, name: "integration-worker", branch: "int" }, report)
    .includes(`REPORT BODY (complete):\n${report}\n\nFINAL VERDICT: FAIL.`));
});

test("supports normalized text and legacy string or text-block content", () => {
  assert.equal(messageText({ text: "normalized ✓\nsecond line" }), "normalized ✓\nsecond line");
  assert.equal(messageText({ content: "legacy string" }), "legacy string");
  assert.equal(messageText({ content: [
    { type: "text", text: "legacy " },
    { type: "thinking", thinking: "do not include" },
    { type: "toolCall", name: "bash" },
    { type: "text", text: "blocks" },
    { type: "text", text: 42 },
    null,
  ] }), "legacy blocks");
});

test("collects all assistant messages and excludes user, tools, thinking, and malformed entries", () => {
  const text = collectAssistantText([
    { type: "message", role: "assistant", text: "one" },
    { type: "message", role: "user", text: "exclude user" },
    { type: "message", role: "assistant", content: [
      { type: "thinking", thinking: "exclude thinking" },
      { type: "text", text: "two" },
    ] },
    { type: "tool_result", role: "assistant", text: "exclude tool result" },
    { type: "message", role: "assistant", content: [{ type: "text", text: false }] },
    null,
  ]);
  assert.equal(text, "one\ntwo");
});

test("uses an empty current invocation instead of old transcript output", () => {
  const previous = new InvocationCapture();
  previous.add({ type: "message", role: "assistant", text: "old criteria" });
  const current = new InvocationCapture();
  assert.equal(previous.text(), "old criteria");
  assert.equal(current.text(), "");
  assert.equal(hasCriteria(current.text()), false);
  assert.equal(isSkipValidation(current.text()), false);
  assert.equal(isSkipValidation("  SKIP VALIDATION"), true);
  assert.equal(isSkipValidation(""), false);
  assert.match(missingCriteriaDiagnostic("impl"), /current planner run/);
  assert.match(missingCriteriaDiagnostic("impl"), /No old transcript text was used/);
});

test("keeps deferred criteria and report paired across a later implementor continuation", () => {
  const worker = { id: "impl-2", lastRunText: "first completed report ✓" };
  const pending = pendingValidationFor(worker, "1. Check first run.\n2. Verify ✓.");
  worker.lastRunText = "later continued run report";
  assert.equal(pending.criteria, "1. Check first run.\n2. Verify ✓.");
  assert.equal(reportForValidation(worker, pending.report), "first completed report ✓");
  assert.equal(reportForValidation(worker, undefined), "later continued run report");
  assert.equal(reportForValidation({ lastRunText: "" }, ""),
    "[No assistant implementor report text was produced by this run.]");
});

test("keeps invocation output outside the capped UI transcript", () => {
  const transcript = [];
  const run = new InvocationCapture();
  for (let i = 0; i < 505; i += 1) {
    const entry = { type: "message", role: "assistant", text: `item-${i}` };
    run.add(entry);
    appendTranscript(transcript, entry, 500);
  }
  assert.equal(transcript.length, 500);
  assert.equal(transcript[0].text, "item-5");
  assert.equal(run.text().split("\n").length, 505);
  assert.ok(run.text().startsWith("item-0\n"));
});

test("builds full implementor, validation, and integration reports without dot-only text", () => {
  const report = "Changed it ✓\nLine two!\nVERDICT: PASS";
  const worker = { id: "impl-1", name: "impl", harness: "pi", sessionId: "s-1", branch: "b" };
  const implNotice = buildImplementorNotification(worker, report);
  assert.ok(implNotice.includes(`REPORT BODY (complete):\n${report}\n\nNow give`));
  assert.ok(!implNotice.includes("finished: ."));
  assert.ok(buildImplementorNotification(worker, "").includes(
    "[No assistant report text was produced by this run.]"));
  assert.equal(runOutputNote("partial ✓\nline!"), "\n\nRUN OUTPUT (complete):\npartial ✓\nline!");
  assert.match(runOutputNote("", "validation run output"), /No validation run output text was produced/);

  const validator = { id: "val-1", name: "validator-impl", validates: worker.id,
    branch: "b", verdict: "pass" };
  const validation = buildValidationNotification(validator, worker, report);
  assert.ok(validation.includes(`REPORT BODY (complete):\n${report}\n\nFINAL VERDICT: PASS.`));
  assert.ok(validation.includes("/continue"));

  const integration = buildIntegrationNotification({ ...validator, name: "integration", branch: "i" }, report);
  assert.ok(integration.includes(`REPORT BODY (complete):\n${report}\n\nFINAL VERDICT: PASS.`));
});

test("parses only complete explicit verdict lines outside quotes and code fences", () => {
  assert.equal(explicitVerdict("> VERDICT: PASS\n`VERDICT: FAIL`\nVERDICT: PASS"), "pass");
  assert.equal(explicitVerdict("Example: VERDICT: PASS\nVERDICT: PASS — pending"), null);
  assert.equal(explicitVerdict("VERDICT: PASS\nAdditional incomplete output"), null);
  assert.equal(explicitVerdict("VERDICT: PASS\n  > quoted trailing line"), null);
  assert.equal(explicitVerdict("VERDICT: PASS\nVERDICT: FAIL"), "fail");
  assert.equal(explicitVerdict("verdict: PASS"), null);
  assert.equal(explicitVerdict("```\nVERDICT: PASS\n```\nVERDICT: FAIL"), "fail");
  assert.equal(explicitVerdict("No verdict"), null);
});

test("publishes completion state before API, saved-state, and event projections", () => {
  for (const [report, expected] of [
    ["Evidence\nVERDICT: PASS", "pass"],
    ["Evidence\nVERDICT: FAIL", "fail"],
    ["Evidence\nVERDICT: PASS maybe", null],
  ]) {
    const worker = { id: "v-1", role: "validator", status: "running", verdict: null };
    const event = applyCompletion(worker, "ok", false, report);
    const saved = { ...completionFields(worker) };
    const api = { ...completionFields(worker) };
    assert.equal(worker.status, "completed");
    assert.equal(worker.verdict, expected);
    assert.deepEqual(saved, api);
    assert.deepEqual(event, { workerId: "v-1", status: "completed", verdict: expected });
    const notice = buildValidationNotification({ ...worker, name: "v", validates: "i", branch: "b" }, null, report);
    if (expected) assert.ok(notice.includes(`FINAL VERDICT: ${expected.toUpperCase()}.`));
    else assert.ok(notice.includes("DIAGNOSTIC: no explicit final"));
  }
});

test("does not publish a verdict for a failed or stopped validator run", () => {
  for (const [outcome, stopped, status] of [["fail", false, "failed"], ["ok", true, "stopped"]]) {
    const worker = { id: "v-2", role: "validator", status: "running", verdict: null };
    applyCompletion(worker, outcome, stopped, "VERDICT: PASS");
    assert.equal(worker.status, status);
    assert.equal(worker.verdict, null);
  }
});
