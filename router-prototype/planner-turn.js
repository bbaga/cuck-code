"use strict";

const START = "--- PLANNER TURN CONTEXT ---";
const END = "--- END PLANNER TURN CONTEXT ---";

function wrapPlannerTurn(input, { lineId, approved, workdir }) {
  let payload = String(input);
  const start = payload.indexOf(START);
  const end = payload.indexOf(END);
  if (start !== -1 && end > start) {
    payload = payload.slice(end + END.length).replace(/^\n+/, "");
  }
  const state = approved ? "APPROVED" : "NOT APPROVED";
  const action = approved
    ? "Spawn implementors through the router API, or handle the current report. Do not implement directly."
    : "Write or revise plan.md and wait. Do not spawn workers or implement. Only the router approval event changes this state.";
  return `${START}\nROLE: PLANNER. You plan and coordinate only.\nLINE ID: ${lineId}\nAPPROVAL STATE: ${state}\nALLOWED NEXT ACTION: ${action}\nWORKDIR BOUNDARY: Read-only inspection is allowed. Write or commit plan.md only inside ${workdir}. Never edit application code, tests, configuration, application prompts, parent repositories, or shared checkouts.\nSTOP CONDITION: Before approval, provide a plan or plan revision and a short summary, then end the turn. After spawning workers, end the turn and wait for actual reports. Never treat continue as approval. Preserve event markers, report bodies, verdicts, and numbered-list-only criteria instructions.\n${END}\n${payload}`;
}

module.exports = { wrapPlannerTurn };
