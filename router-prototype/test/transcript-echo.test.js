"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { recordRequestEntry, isPromptEcho } = require("../transcript-echo");
const { plannerRequest, restorePlannerRequest, recordedPlannerRequest,
  serializePlannerRequest, submitPrompt } = require("../planner-request");

function harness() {
  const line = { transcript: [], queue: [], started: false };
  const sent = [];
  const deps = { append: (t, e) => t.push(e), broadcast: (l, ev, e) => sent.push([ev, e]) };
  return { line, sent, deps };
}

test("a user request keeps raw text, not the wrapper", () => {
  const { line, sent, deps } = harness();
  const req = plannerRequest("PLAN FEEDBACK from the user: fix it.", null, null, "fix it");
  const entry = recordRequestEntry(line, req, deps);
  assert.equal(entry.content, "fix it");
  assert.equal(entry.origin, undefined);
  assert.equal(line.transcript.length, 1);
  assert.equal(sent.length, 1);
});

test("a router request makes one collapsed router entry", () => {
  const { line, sent, deps } = harness();
  recordRequestEntry(line, plannerRequest("WORKER REPORT x"), deps);
  assert.equal(line.transcript[0].origin, "router");
  assert.equal(line.transcript[0].content, "WORKER REPORT x");
  assert.deepEqual(sent.map((s) => s[0]), ["entry"]);
});

test("fromUser and recorded flags survive save and restore", () => {
  const req = plannerRequest("wrapped", null, null, "raw");
  const back = restorePlannerRequest(JSON.parse(JSON.stringify(serializePlannerRequest(req))));
  assert.equal(back.fromUser, true);
  assert.equal(back.userText, "raw");
  const rec = recordedPlannerRequest(plannerRequest("WORKER REPORT"));
  const again = restorePlannerRequest(JSON.parse(JSON.stringify(serializePlannerRequest(rec))));
  assert.equal(again.recorded, true);
  assert.equal(again.fromUser, undefined);
});

test("accepted prompt keeps the flag in the queue; rejected prompt adds none", () => {
  const line = { queue: [], started: true };
  const ok = submitPrompt(line, plannerRequest("w", null, null, "raw"),
    { wasStarted: true, save: () => true, pump: () => {} });
  assert.equal(ok.status, 202);
  assert.equal(line.queue[0].userText, "raw");
  const bad = submitPrompt({ queue: [], started: true }, plannerRequest("w", null, null, "raw"),
    { wasStarted: true, save: () => false, pump: () => {} });
  assert.equal(bad.status, 500);
});

test("role user harness entries are dropped", () => {
  assert.equal(isPromptEcho({ type: "message", role: "user", text: "x" }), true);
  assert.equal(isPromptEcho({ type: "message", role: "assistant", text: "x" }), false);
});

test("entryEl draws a closed details element for router messages", () => {
  const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
  const start = html.indexOf("function textOf(entry)");
  const end = html.indexOf("async function renderPlan");
  const mk = (tag) => ({ tag, children: [], className: "", open: false,
    append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); },
    set textContent(v) { this._t = v; }, get textContent() { return this._t; } });
  const ctx = { document: { createElement: mk, createTextNode: (t) => ({ t }) }, Date };
  vm.runInNewContext(html.slice(start, end) + ";this.entryEl = entryEl;", ctx);
  const long = "a".repeat(150) + "\nsecond";
  const div = ctx.entryEl({ type: "message", role: "user", origin: "router", content: long, at: 1 });
  const d = div.children.find((c) => c.tag === "details");
  assert.ok(d);
  assert.equal(d.open, false);
  assert.match(d.children[0].textContent, /^Router message: a{100}…$/);
  assert.equal(d.children[1].textContent, long);
  const user = ctx.entryEl({ type: "message", role: "user", content: "hi" });
  assert.equal(user.className, "user");
});
