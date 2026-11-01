"use strict";

// C6: reports as interactions. The new template must render the old report
// texts (one sentence of the implementor report differs), the flow flag must
// survive a restart.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { loadBuiltinPipeline } = require("../line-graph");
const { renderReports, reportValues, completeInteractions, kindOfNode, outcomeOf } = require("../report-interaction");
const { runOutputNote } = require("../handoff");
const { golden } = require("./fixtures/golden-file");
const { plannerRequest, interactionReportRequest, serializePlannerRequest, restorePlannerRequest,
  enqueuePlannerRequest, recordedPlannerRequest } = require("../planner-request");
const { startRouter, stopRouter } = require("./fixtures/router-process");

const ROOT = path.join(__dirname, "..");
const graph = loadBuiltinPipeline("default", fs, ROOT);

const impl = { id: "w1", name: "api", node: "backend-impl", role: "implementor", harness: "claude",
  sessionId: "s1", branch: "feat/x", status: "completed" };
const val = { id: "v1", name: "api-check", node: "backend-val", role: "validator", kind: "validator",
  harness: "vibe", branch: "feat/x", validates: "w1", status: "completed" };
const integ = { id: "g1", name: "int", node: "integration", role: "validator", kind: "integration",
  harness: "vibe", branch: "int/x", status: "completed" };

function newText(worker, report, { source = null, timedOut = false } = {}) {
  const out = renderReports({ graph, worker, source, report, timedOut });
  assert.equal(out.length, 1);
  assert.equal(out[0].target, "starter");
  assert.equal(out[0].to, "planner");
  return out[0].text;
}

const OLD_CRITERIA_TAIL = "Now give the acceptance criteria for the validation of this work.\nReply with a numbered list of criteria only. Use the imperative. If\nthe work needs no validation, reply with SKIP VALIDATION.";
// The planner decision sentences name the interaction calls now.
function newDecisions(oldText) {
  return oldText
    .replace(/Decide: accept the work, send follow-up instructions to the original implementor \(POST \/api\/protocol\/workers\/([^/]+)\/continue with \{"prompt": \.\.\.\}\), or spawn a new implementor with a corrected prompt\./,
      "Decide: accept the work, send feedback to the original implementor (instance $1), or start a new implementor with a corrected task.")
    .replace("Decide: report completion to the user, or route fixes to the ORIGINAL implementors (continue endpoint) and start a new integration validator after they pass again.",
      "Decide: report completion to the user, or send feedback to the ORIGINAL implementors and, after they pass again, start the integration node again.");
}

const NEW_CRITERIA_TAIL = "Now give the acceptance criteria for the validation of this work.\nStart a validator with the criteria. If the work needs no validation, accept it.";

// The golden files test/fixtures/golden/report-* hold the output of the removed
// buildImplementorNotification(), buildValidationNotification() and
// buildIntegrationNotification() for the inputs below. A one-off script produced them
// before D9 removed the functions. The tests apply the two documented text changes.
const REPORTS = [["did-the-work", "Did the work."], ["empty", ""], ["undefined", undefined], ["two-lines", "line1\nline2"]];

test("completed implementor: equals the golden old report except one sentence", () => {
  for (const [rs, report] of REPORTS) {
    for (const [ss, w] of [["with-session", impl], ["no-session", { ...impl, sessionId: undefined, harness: undefined }]]) {
      const old = golden(`report-implementor-${rs}-${ss}`);
      assert.ok(old.endsWith(OLD_CRITERIA_TAIL));
      const expected = old.slice(0, old.length - OLD_CRITERIA_TAIL.length) + NEW_CRITERIA_TAIL;
      assert.equal(newText(w, report), expected, `${rs} ${ss}`);
    }
  }
});

test("completed validator: equals the golden old report for pass, reject and missing", () => {
  const sources = [["session", impl], ["no-session", { ...impl, sessionId: undefined, harness: undefined }], ["no-source", null]];
  for (const [sn, s] of sources) {
    for (const verdict of ["pass", "fail", null]) {
      for (const [rn, report] of [["verdict-line", "Checked.\nVERDICT: PASS"], ["empty", ""]]) {
        const w = { ...val, verdict };
        assert.equal(newText(w, report, { source: s }),
          newDecisions(golden(`report-validator-${sn}-${verdict || "none"}-${rn}`)), `${sn} ${verdict} ${rn}`);
      }
    }
  }
});

test("completed integration validator: equals the golden old report", () => {
  for (const verdict of ["pass", "fail", null]) {
    for (const [rn, report] of [["merged", "Merged."], ["empty", ""]]) {
      const w = { ...integ, verdict };
      assert.equal(newText(w, report), newDecisions(golden(`report-integration-${verdict || "none"}-${rn}`)),
        `${verdict} ${rn}`);
    }
  }
});

// The old failure, stop and timeout texts, as workerClosed() built them.
const note = (w) => (w.lastError ? `\n\nFAILURE DETAIL:\n${w.lastError}` : "");
const oldImplementor = (w, status, timedOut, report) => {
  const sid = w.sessionId || "unknown";
  const tail = runOutputNote(report, "implementor run output") + note(w);
  if (timedOut) return `WORKER TIMEOUT - worker hit the run time limit and was interrupted. Its session and its work are intact. Continue the ORIGINAL session so it can finish: send feedback to instance ${w.id} with the instructions "Finish the work from where the run was interrupted. Then report." After it completes, the validation loop runs as usual.` + tail;
  if (status === "failed") return `WORKER FAILURE - '${w.name}' (workerId ${w.id}, session ${sid}): ${w.harness || "vibe"} failed (see FAILURE DETAIL). Decide whether to restart it with a corrected prompt (new name, e.g. ${w.name}-2) or to proceed without it.` + tail;
  return `WORKER STOPPED - '${w.name}' (workerId ${w.id}, session ${sid}) was stopped (user request or timeout). Decide whether to restart it with an updated prompt (new name) or to proceed.` + tail;
};
const oldValidator = (w, impl2, status, timedOut, report) => {
  const implName = impl2 ? impl2.name : "unknown";
  const implId = w.validates || "unknown";
  const tail = runOutputNote(report, "validation run output") + note(w);
  if (timedOut) return `VALIDATOR TIMEOUT - the validator hit the run time limit and was interrupted. Validators are fresh sessions each time: the implementor work is unchanged, decide how to proceed (usually nothing - validation repeats after the next implementor completion).` + tail;
  if (status === "failed") return `VALIDATOR FAILURE - validator '${w.name}' (checking implementor '${implName}', workerId ${implId}) failed (see FAILURE DETAIL). Decide how to proceed.` + tail;
  return `VALIDATOR STOPPED - validator '${w.name}' (checking implementor '${implName}', workerId ${implId}) was stopped. Decide how to proceed.` + tail;
};
const oldIntegration = (w, status, timedOut, report) => {
  const tail = runOutputNote(report, "integration run output") + note(w);
  if (timedOut) return `INTEGRATION TIMEOUT - integration validator '${w.name}' hit the run time limit. The merged work is on branch ${w.branch}. Decide how to proceed.` + tail;
  return `INTEGRATION STOPPED/FAILED - integration validator '${w.name}' did not complete. Its worktree may be partially merged. Decide how to proceed.` + tail;
};

test("timeout, failed and stopped runs equal the old texts for every node kind", () => {
  const cases = [["timeout", true, "stopped"], ["failed", false, "failed"], ["stopped", false, "stopped"]];
  for (const [, timedOut, status] of cases) {
    for (const report of ["partial output", ""]) {
      for (const lastError of [null, "boom\nsecond line"]) {
        const i = { ...impl, status, lastError };
        assert.equal(newText(i, report, { timedOut }), oldImplementor(i, status, timedOut, report));
        const i2 = { ...i, sessionId: undefined, harness: undefined };
        assert.equal(newText(i2, report, { timedOut }), oldImplementor(i2, status, timedOut, report));
        const v = { ...val, status, lastError };
        assert.equal(newText(v, report, { source: impl, timedOut }), oldValidator(v, impl, status, timedOut, report));
        assert.equal(newText(v, report, { source: null, timedOut }), oldValidator(v, null, status, timedOut, report));
        const g = { ...integ, status, lastError };
        assert.equal(newText(g, report, { timedOut }), oldIntegration(g, status, timedOut, report));
      }
    }
  }
});

test("outcome and from.type are objects of flags with exactly one true outcome", () => {
  const cases = [
    [{ ...impl }, false, "done", "implementor"],
    [{ ...val, verdict: "pass" }, false, "pass", "validator"],
    [{ ...val, verdict: "fail" }, false, "reject", "validator"],
    [{ ...val, verdict: null }, false, "missing", "validator"],
    [{ ...integ, verdict: "pass" }, false, "pass", "integration"],
    [{ ...impl, status: "stopped" }, true, "timeout", "implementor"],
    [{ ...impl, status: "failed" }, false, "failed", "implementor"],
    [{ ...impl, status: "stopped" }, false, "stopped", "implementor"],
  ];
  for (const [worker, timedOut, outcome, kind] of cases) {
    const v = reportValues({ graph, worker, source: null, report: "r", timedOut });
    assert.deepEqual(Object.keys(v.outcome).sort(),
      ["done", "failed", "missing", "pass", "reject", "stopped", "timeout"]);
    assert.deepEqual(Object.keys(v.outcome).filter((k) => v.outcome[k]), [outcome]);
    assert.deepEqual(Object.keys(v.from.type).filter((k) => v.from.type[k]), [kind]);
    assert.equal(outcomeOf(graph, worker, timedOut), outcome);
  }
  const v = reportValues({ graph, worker: { ...impl, sessionId: undefined }, source: null, report: "", timedOut: false });
  assert.equal(v.from.session, "unknown");
  assert.equal(v.from.error, "");
  assert.equal(v.source.name, "unknown");
  assert.equal(v.report, "[No assistant report text was produced by this run.]");
});

test("a node without a complete edge, or an unknown node, delivers nothing", () => {
  const planner = { ...impl, node: "planner" };
  assert.deepEqual(completeInteractions(graph, "planner"), []);
  assert.deepEqual(renderReports({ graph, worker: planner, report: "x" }), []);
  assert.equal(kindOfNode(graph, "ghost"), null);
  assert.deepEqual(renderReports({ graph, worker: { ...impl, node: "ghost" }, report: "x" }), []);
  const lone = { ...graph, edges: graph.edges.filter((e) => e.from !== "backend-impl") };
  assert.deepEqual(renderReports({ graph: lone, worker: impl, report: "x" }), []);
});

test("the flow flag survives serialization, restore and the recorded copy", () => {
  const request = interactionReportRequest("IMPLEMENTOR REPORT - x");
  assert.equal(request.flow, "interactions");
  assert.equal("source" in request, false);
  const stored = JSON.parse(JSON.stringify(serializePlannerRequest(request)));
  assert.equal(stored.flow, "interactions");
  const restored = restorePlannerRequest(stored);
  assert.equal(restored.flow, "interactions");
  assert.equal(recordedPlannerRequest(restored).flow, "interactions");
  const line = { queue: [], knownNoticeIds: [], deleted: false };
  enqueuePlannerRequest(line, request, () => true);
  assert.equal(line.queue[0].flow, "interactions");
  assert.equal("flow" in serializePlannerRequest(plannerRequest("plain")), false);
  assert.equal(restorePlannerRequest({ text: "t", flow: "other" }).flow, undefined);
});

test("a new report request carries the flow flag and no source", () => {
  const request = interactionReportRequest(newText(impl, "done"));
  assert.ok(request.text.startsWith("IMPLEMENTOR REPORT"));
  assert.equal("source" in request, false);
  assert.equal(request.flow, "interactions");
});

// End to end: a real router and fake agents.
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
  { encoding: "utf8" }).trim();

test("end to end: a finished implementor sends the new report to the planner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-interaction-"));
  let router;
  try {
    const linesDir = path.join(root, "lines");
    fs.mkdirSync(linesDir);
    const src = path.join(root, "src", "api");
    fs.mkdirSync(src, { recursive: true });
    git(src, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(src, "a.txt"), "a");
    git(src, "add", ".");
    git(src, "commit", "-qm", "init");
    const head = git(src, "rev-parse", "HEAD");
    const id = "ri-line";
    const lineDir = path.join(linesDir, id);
    fs.mkdirSync(lineDir);
    const clone = path.join(lineDir, "repos", "api");
    execFileSync("git", ["clone", "-q", src, clone]);
    fs.writeFileSync(path.join(lineDir, "line.json"), JSON.stringify({
      id, name: id, layout: 2, started: true, planApproved: true,
      repos: [{ name: "api", url: src, path: clone }],
      workers: [{ id: "i1", name: "impl", node: "backend-impl", persona: "backend", role: "implementor",
        status: "completed", repo: "api", branch: "b/impl", runGeneration: 1, sessionId: "sess-1",
        harness: "claude", lastCompletedInvocationId: "inv-i1", baseCommit: head, worktreePath: clone }] }));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const log = path.join(root, "agent-args.log");
    // The worker run ends at once; any other run (the planner) stays alive.
    const script = `#!/bin/sh\nprintf '%s\\n----\\n' "$*" >> "${log}"\ncase "$*" in *"Follow-up instructions"*) exit 0;; esac\nsleep 60\n`;
    for (const agent of ["claude", "vibe", "codex", "pi"]) {
      fs.writeFileSync(path.join(bin, agent), script);
      fs.chmodSync(path.join(bin, agent), 0o755);
    }
    router = await startRouter(linesDir, { ROUTER_ALLOW_LOCAL_REPOS: "1", PATH: `${bin}:${process.env.PATH}` });
    const res = await fetch(`${router.base}/api/protocol/lines/${id}/interactions/feedback`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instance: "i1", instructions: "Fix the header." }) });
    assert.equal(res.status, 202, await res.text());
    let text = "";
    for (let i = 0; i < 100; i++) {
      text = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
      if (text.includes("IMPLEMENTOR REPORT")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(text, /IMPLEMENTOR REPORT - 'impl' \(workerId i1, claude session sess-1, branch b\/impl\) finished\./, text);
    assert.match(text, /Start a validator with the criteria\. If the work needs no validation, accept it\./);
    assert.ok(!text.includes("SKIP VALIDATION"));
    // The request is the active planner request, and it carries the flag.
    let saved;
    for (let i = 0; i < 50; i++) {
      saved = JSON.parse(fs.readFileSync(path.join(lineDir, "line.json"), "utf8"));
      if (saved.activePlannerRequest) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const request = saved.activePlannerRequest || (saved.queue || [])[0];
    assert.ok(request, JSON.stringify(Object.keys(saved)));
    assert.equal(request.flow, "interactions");
    assert.equal(request.source, undefined);
    assert.ok(!text.includes("VALIDATION NOT STARTED"));
  } finally {
    if (router) await stopRouter(router);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
