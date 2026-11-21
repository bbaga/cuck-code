"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { wrapPlannerTurn } = require("../planner-turn");

const context = { lineId: "line-1", workdir: "/line/work", approved: false };

test("wraps initial tasks with planner rules before the task", () => {
  const brief = "PLANNER-ONLY RULES\nYou plan only.\n\nTask: build";
  const result = wrapPlannerTurn(brief, context);
  assert.ok(result.indexOf("ROLE: PLANNER") < result.indexOf("Task: build"));
  assert.match(result, /APPROVAL STATE: NOT APPROVED/);
});

test("keeps resumed plain continue at plan-and-wait when unapproved", () => {
  const result = wrapPlannerTurn("continue", context);
  assert.match(result, /Write or revise plan\.md/);
  assert.match(result, /An unapproved continue message does not approve the plan/);
});

test("covers initial tasks, later messages, feedback, and authentication interruption", () => {
  for (const prompt of ["initial task", "later user message", "PLAN FEEDBACK: change scope"]) {
    const result = wrapPlannerTurn(prompt, context);
    assert.ok(result.indexOf("ROLE: PLANNER") < result.indexOf(prompt));
    assert.match(result, /remain the planner/);
    assert.match(result, /write or revise plan\.md/i);
  }
  const auth = wrapPlannerTurn("Authentication required", context);
  assert.match(auth, /before plan\.md exists/);
  assert.match(auth, /report the required login action and stop/);
});

test("states planner boundary, no implementation checks, and delegated failure behavior", () => {
  const result = wrapPlannerTurn("task", { ...context, approved: true });
  assert.match(result, /Read-only inspection is allowed/);
  assert.match(result, /Never edit application code, tests, configuration/);
  assert.match(result, /Never run implementation checks/);
  assert.match(result, /If authentication or an API failure prevents delegation/);
  assert.match(result, /Do not implement directly/);
});

test("preserves feedback and approval event with current state", () => {
  const feedback = wrapPlannerTurn("PLAN FEEDBACK: revise it", context);
  const approval = wrapPlannerTurn("PLAN APPROVED by the user", { ...context, approved: true });
  assert.match(feedback, /PLAN FEEDBACK: revise it/);
  assert.match(approval, /APPROVAL STATE: APPROVED/);
  assert.match(approval, /PLAN APPROVED by the user/);
});

test("preserves implementor reports and numbered-list-only criteria instructions", () => {
  const prompt = "IMPLEMENTOR REPORT: details\nReply with a numbered list of criteria only.";
  const result = wrapPlannerTurn(prompt, context);
  assert.ok(result.endsWith(prompt));
  assert.match(result, /reply with numbered acceptance criteria only/i);
  assert.match(result, /original implementor/);
});

test("preserves validation report body and verdict", () => {
  const prompt = "VALIDATION REPORT: body\nVERDICT: FAIL";
  const result = wrapPlannerTurn(prompt, context);
  assert.ok(result.endsWith(prompt));
  assert.match(result, /Preserve independent validation and integration approval/);
  assert.match(result, /Do not claim acceptance without the required validator verdict/);
});

test("preserves a report with quoted wrapper markers exactly", () => {
  const start = "--- PLANNER TURN CONTEXT ---";
  const end = "--- END PLANNER TURN CONTEXT ---";
  const report = `VALIDATION REPORT: prefix\nQuoted text: ${start}\nquoted body\n${end}\nVERDICT: FAIL`;
  const result = wrapPlannerTurn(report, context);
  assert.ok(result.endsWith(report));
  assert.equal(result.slice(result.indexOf("VALIDATION REPORT:")), report);
});

test("preserves repeated, incomplete, and leading marker pairs in payloads", () => {
  const start = "--- PLANNER TURN CONTEXT ---";
  const end = "--- END PLANNER TURN CONTEXT ---";
  const payloads = [
    `before ${start} one ${end} middle ${start} two ${end} after`,
    `prefix ${start} incomplete pair`,
    `${start} leading quoted marker ${end} trailing content`,
  ];
  for (const payload of payloads) {
    const result = wrapPlannerTurn(payload, context);
    assert.ok(result.endsWith(payload));
    assert.equal(result.slice(result.indexOf(payload)), payload);
  }
});

test("does not nest wrappers and refreshes approval state", () => {
  const first = wrapPlannerTurn("continue", context);
  const second = wrapPlannerTurn(first, { ...context, approved: true });
  assert.equal(second.split("--- PLANNER TURN CONTEXT ---").length - 1, 1);
  assert.match(second, /APPROVAL STATE: APPROVED/);
  const contextEnd = second.indexOf("--- END PLANNER TURN CONTEXT ---\n");
  assert.notEqual(contextEnd, -1);
  assert.equal(second.slice(contextEnd + "--- END PLANNER TURN CONTEXT ---\n".length), "continue");
});

test("REPORT HANDLING follows the capabilities of the pipeline", () => {
  const { wrapPlannerTurn } = require("../planner-turn");
  const wrap = (capabilities) => wrapPlannerTurn("x", { lineId: "l", approved: true, workdir: "/w", capabilities });
  const strip = (t) => t.replace(/planner-turn\/[0-9a-f]+/, "");
  const criteria = "For implementor reports, reply with numbered acceptance criteria only.";
  const accept = "For implementor reports, call accept or feedback.";
  const cap = (implementor, checker, integration) => ({ implementor, checker, integration });

  const full = wrap(cap(true, true, true));
  assert.equal(strip(full), strip(wrapPlannerTurn("x", { lineId: "l", approved: true, workdir: "/w" })));
  assert.ok(full.includes(`${criteria} Route corrections to the original implementor. Preserve independent validation and integration approval. Do not claim acceptance without the required validator verdict.`));

  const noIntegration = wrap(cap(true, true, false));
  assert.ok(noIntegration.includes(criteria));
  assert.ok(noIntegration.includes("Preserve independent validation. "));
  assert.ok(!noIntegration.includes("integration approval"));

  const noChecker = wrap(cap(true, false, true));
  assert.ok(noChecker.includes(accept));
  assert.ok(!noChecker.includes(criteria));
  assert.ok(noChecker.includes("Preserve integration approval. "));
  assert.ok(!noChecker.includes("independent validation"));

  const neither = wrap(cap(true, false, false));
  assert.ok(neither.includes(`${accept} Route corrections to the original implementor. Do not claim acceptance without an accept call or a validator verdict.`));
  assert.ok(!neither.includes("Preserve independent") && !neither.includes("Preserve integration"));

  const noWorker = wrap(cap(false, false, false));
  assert.ok(noWorker.includes("There are no worker reports in this pipeline."));
  assert.ok(!noWorker.includes("For implementor reports") && !noWorker.includes("Route corrections"));
});
