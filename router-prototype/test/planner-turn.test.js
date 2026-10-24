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
  assert.match(result, /Write or revise plan\.md and wait/);
  assert.match(result, /Never treat continue as approval/);
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
});

test("preserves validation report body and verdict", () => {
  const prompt = "VALIDATION REPORT: body\nVERDICT: FAIL";
  assert.ok(wrapPlannerTurn(prompt, context).endsWith(prompt));
});

test("does not nest wrappers and refreshes approval state", () => {
  const first = wrapPlannerTurn("continue", context);
  const second = wrapPlannerTurn(first, { ...context, approved: true });
  assert.equal(second.split("--- PLANNER TURN CONTEXT ---").length - 1, 1);
  assert.match(second, /APPROVAL STATE: APPROVED/);
  assert.ok(second.endsWith("continue"));
});
