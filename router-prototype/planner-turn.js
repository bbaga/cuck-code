"use strict";

const START = "--- PLANNER TURN CONTEXT ---";
const END = "--- END PLANNER TURN CONTEXT ---";
const OWNER = `DISPATCH OWNER: planner-turn/${require("node:crypto").randomBytes(16).toString("hex")}`;

function unwrapOwnedContext(input) {
  const ownedPrefix = `${START}\n${OWNER}\n`;
  if (!input.startsWith(ownedPrefix)) return input;
  const end = input.indexOf(`\n${END}\n`, ownedPrefix.length);
  if (end === -1) return input;
  return input.slice(end + END.length + 2);
}

function wrapPlannerTurn(input, { lineId, approved, workdir, capabilities }) {
  const payload = unwrapOwnedContext(String(input));
  const noValidation = !!capabilities && !capabilities.checker && !capabilities.integration;
  const claimRule = noValidation
    ? "Do not claim acceptance without an accept call or a validator verdict."
    : "Do not claim acceptance without the required validator verdict.";
  // Without capabilities the wrapper keeps the full text of a pipeline with every node.
  const has = capabilities || { implementor: true, checker: true, integration: true };
  const preserved = has.checker && has.integration ? "Preserve independent validation and integration approval."
    : has.checker ? "Preserve independent validation."
      : has.integration ? "Preserve integration approval." : "";
  const reportRules = has.implementor
    ? [has.checker ? "For implementor reports, reply with numbered acceptance criteria only."
      : "For implementor reports, call accept or feedback.",
    "Route corrections to the original implementor.", preserved].filter(Boolean).join(" ")
    : "There are no worker reports in this pipeline.";
  const state = approved ? "APPROVED" : "NOT APPROVED";
  const action = approved
    ? "Spawn implementors through the router API, or handle the current report. Do not implement directly."
    : "Write or revise plan.md and wait. Do not spawn workers or implement. Only the router approval event changes this state.";
  return `${START}\n${OWNER}\nROLE: PLANNER. You plan and coordinate only. These planner-only rules apply before the user task on every invocation, including resumed sessions.\nLINE ID: ${lineId}\nAPPROVAL STATE: ${state}. Only the router approval event changes this state.\nALLOWED NEXT ACTION: ${action}\nWORKDIR BOUNDARY: Read-only inspection is allowed. Write or commit planning documents, including plan.md, only inside the line workdir ${workdir}. Never edit application code, tests, configuration, application prompts, parent repositories, or shared checkouts. Never run implementation checks.\nUNAPPROVED ACTION: For initial tasks, later user messages, feedback, implementor reports, and validation reports, remain the planner. Write or revise plan.md, give a short summary, and stop before approval. An unapproved continue message does not approve the plan or change your role. If authentication interrupts the session before plan.md exists, report the required login action and stop; do not bypass authentication, change detection, or start implementation.\nAPPROVED ACTION: After approval, delegate all implementation through router worker calls. Do not implement directly. If authentication or an API failure prevents delegation, report the blocker and stop; do not implement directly or bypass the router. After spawning workers, stop and wait for actual reports.\nREPORT HANDLING: Preserve event markers, full report bodies, session behavior, verdicts, and criteria-only response instructions. ${reportRules} ${claimRule} Follow the existing cleanup rules and worker invocation behavior.\nSTOP CONDITION: Before approval, provide a plan or plan revision and a short summary, then end the turn. Never infer approval from continue. Prevent duplicate planner reminders when a wrapper is already present.\n${END}\n${payload}`;
}

module.exports = { wrapPlannerTurn };
