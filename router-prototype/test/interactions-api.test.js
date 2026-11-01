"use strict";

// POST /api/protocol/lines/:id/interactions/:name through a real router.
// Agents are fake: every harness binary is a script that sleeps.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startRouter, stopRouter } = require("./fixtures/router-process");

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
  { encoding: "utf8" }).trim();

async function call(base, method, pathname, body) {
  const res = await fetch(base + pathname, { method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let root, router, base, src;
const ok = "ia-ok";
const pending = "ia-pending";
const fbLine = "ia-feedback";
const accLine = "ia-accept";
const post = (line, name, body) => call(base, "POST", `/api/protocol/lines/${line}/interactions/${name}`, body);

function seedLine(linesDir, id, planApproved, extra = {}) {
  const lineDir = path.join(linesDir, id);
  fs.mkdirSync(lineDir);
  const clone = path.join(lineDir, "repos", "api");
  execFileSync("git", ["clone", "-q", src, clone]);
  const worker = (wid, name, node) => ({ id: wid, name, node,
    persona: node === "frontend-impl" ? "frontend" : "backend", role: "implementor", status: "completed",
    repo: "api", branch: `b/${name}`, runGeneration: 1, lastCompletedInvocationId: `inv-${wid}`,
    lastRunText: `report of ${name}`,
    worktreePath: path.join(linesDir, "worktrees", id, "api", name), ...(extra[wid] || {}) });
  fs.writeFileSync(path.join(lineDir, "line.json"), JSON.stringify({
    id, name: id, layout: 2, started: true, planApproved,
    repos: [{ name: "api", url: src, path: clone }],
    workers: [worker("i1", "impl", "backend-impl"), worker("f1", "front", "frontend-impl")] }));
}

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "interactions-api-"));
  const linesDir = path.join(root, "lines");
  fs.mkdirSync(linesDir);
  src = path.join(root, "src", "api");
  fs.mkdirSync(src, { recursive: true });
  git(src, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(src, "a.txt"), "a");
  git(src, "add", ".");
  git(src, "commit", "-qm", "init");
  seedLine(linesDir, ok, true);
  seedLine(linesDir, pending, false);
  git(src, "branch", "b/impl");
  git(src, "branch", "b/front");
  // Lines with idle instances that have a session (the fake agent logs its arguments).
  for (const id of [fbLine, accLine]) {
    seedLine(linesDir, id, true, { i1: { sessionId: "sess-1", harness: "claude",
      worktreePath: path.join(linesDir, id, "repos", "api") } });
  }
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  for (const agent of ["claude", "vibe", "codex", "pi"]) {
    fs.writeFileSync(path.join(bin, agent), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${path.join(root, "agent-args.log")}"\nsleep 60\n`);
    fs.chmodSync(path.join(bin, agent), 0o755);
  }
  router = await startRouter(linesDir, { ROUTER_ALLOW_LOCAL_REPOS: "1",
    PATH: `${bin}:${process.env.PATH}` });
  base = router.base;
});

test.after(async () => {
  if (router) await stopRouter(router);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an unknown line is 404", async () => {
  const out = await post("nope", "start", { to: "backend-impl" });
  assert.equal(out.status, 404);
  assert.match(out.body.error, /no such line/);
});

test("an unknown interaction is 404", async () => {
  const out = await post(ok, "nonsense", {});
  assert.equal(out.status, 404);
  assert.match(out.body.error, /no such interaction/);
});

test("a complete-triggered interaction is 405", async () => {
  const out = await post(ok, "report", {});
  assert.equal(out.status, 405);
  assert.match(out.body.error, /the router performs this interaction/);
});

test("an unknown or missing target node is 404", async () => {
  assert.equal((await post(ok, "start", { to: "ghost" })).status, 404);
  assert.equal((await post(ok, "start", {})).status, 404);
});

test("a chosen target: missing instance is 400, unknown instance is 404", async () => {
  const missing = await post(ok, "feedback", { instructions: "x" });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "INTERACTION_FIELDS");
  assert.deepEqual(missing.body.missing.map((m) => m.field), ["instance"]);
  const unknown = await post(ok, "feedback", { instance: "ghost", instructions: "x" });
  assert.equal(unknown.status, 404);
});

test("a call with no edge is 403 NO_EDGE and lists what is allowed", async () => {
  const bad = await post(ok, "start", { to: "planner" });
  assert.equal(bad.status, 403);
  assert.equal(bad.body.code, "NO_EDGE");
  assert.ok(Array.isArray(bad.body.allowed));
  assert.ok(bad.body.allowed.some((a) => a.interaction === "start" && a.to === "backend-impl"));
  assert.ok(bad.body.allowed.every((a) => typeof a.interaction === "string" && typeof a.to === "string"));
});

test("a 400 lists two missing fields and one unexpected field", async () => {
  const out = await post(ok, "start", { to: "backend-impl", persona: "x" });
  assert.equal(out.status, 400);
  assert.equal(out.body.code, "INTERACTION_FIELDS");
  assert.equal(out.body.interaction, "start");
  assert.equal(out.body.to, "backend-impl");
  assert.match(out.body.error, /^start of node 'backend-impl' is incomplete: fill every listed field$/);
  assert.deepEqual(out.body.missing.map((m) => m.field).sort(), ["repo", "task"]);
  assert.ok(out.body.missing.every((m) => m.description && m.requiredBy));
  assert.deepEqual(out.body.unexpected, ["persona"]);
  assert.deepEqual(out.body.invalid, []);
  assert.equal(out.body.expected.task, "text, required");
  assert.ok(!("to" in out.body.expected));
});

test("an unapproved plan is 409", async () => {
  const out = await post(pending, "start", { to: "backend-impl", task: "t", repo: "api" });
  assert.equal(out.status, 409);
  assert.equal(out.body.error, "plan not approved");
});

// The saved line file holds the full record of an instance.
const stateOf = async (line, id) => JSON.parse(fs.readFileSync(path.join(root, "lines", line, "line.json"), "utf8"))
  .workers.find((w) => w.id === id);

test("C4: feedback through the endpoint runs the implementor again with the rendered text", async () => {
  const out = await post(fbLine, "feedback", { instance: "i1", instructions: "Fix the header." });
  assert.equal(out.status, 202, JSON.stringify(out.body));
  assert.deepEqual(out.body, { queued: true, compacting: false });
  const w = await stateOf(fbLine, "i1");
  assert.equal(w.status, "running");
  assert.equal(w.runGeneration, 2);
  const logFile = path.join(root, "agent-args.log");
  for (let i = 0; i < 50 && !fs.existsSync(logFile); i++) await new Promise((r) => setTimeout(r, 100));
  const log = fs.readFileSync(logFile, "utf8");
  assert.ok(log.includes("Follow-up instructions from the planner (write them in ASD-STE100):\nFix the header.\n\nWhen done, reply with a report"), log);
  const again = await post(fbLine, "feedback", { instance: "i1", instructions: "More." });
  assert.equal(again.status, 400, "a running instance is refused by the field check");
});

test("C4: the old /continue route sends the same message as the feedback interaction", async () => {
  const { loadInteraction } = require("../interactions");
  const { render } = require("../template");
  const fb = loadInteraction("interactions/feedback", (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8"));
  const expected = render(fb.body, { instructions: "Same text." });
  const legacy = `Follow-up instructions from the planner (write them in ASD-STE100):
Same text.

When done, reply with a report: what you changed, files changed, how you verified it, open issues. That report goes back to the planner verbatim.`;
  assert.equal(expected, legacy);
});

test("C4: feedback to a node without an edge is 403", async () => {
  const val = await post(ok, "start", { to: "backend-val", criteria: "1. x", source: "i1" });
  assert.equal(val.status, 201, JSON.stringify(val.body));
  const out = await post(ok, "feedback", { instance: val.body.instance.validatorId, instructions: "x" });
  assert.equal(out.status, 403);
  assert.equal(out.body.code, "NO_EDGE");
});

test("C4: feedback to an instance without a session is 409", async () => {
  const out = await post(ok, "feedback", { instance: "f1", instructions: "x" });
  assert.equal(out.status, 409);
  assert.match(out.body.error, /no session/);
});

test("C5: accept records the run and the integration no longer waits for criteria", async () => {
  const before = await call(base, "POST", `/api/protocol/lines/${accLine}/integration`, { prompt: "test all" });
  assert.equal(before.status, 409, JSON.stringify(before.body));
  const reasons = (b) => b.body.blockers.map((x) => [x.workerId, x.reason]);
  assert.deepEqual(reasons(before).filter(([id]) => id === "i1"), [["i1", "awaiting-criteria"]]);
  const out = await post(accLine, "accept", { instance: "i1", reason: "No check needed." });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual(out.body, { accepted: true, instance: "i1", runId: 1 });
  const w = await stateOf(accLine, "i1");
  assert.equal(w.acceptedRuns.length, 1);
  assert.deepEqual({ ...w.acceptedRuns[0], at: typeof w.acceptedRuns[0].at },
    { runId: 1, invocationId: "inv-i1", by: "planner", reason: "No check needed.", at: "string" });
  const after = await call(base, "POST", `/api/protocol/lines/${accLine}/integration`, { prompt: "test all" });
  if (after.status === 409 && after.body.blockers) {
    assert.ok(!reasons(after).some(([id]) => id === "i1"), JSON.stringify(after.body));
  }
});

test("C5: accept of a running instance is refused", async () => {
  const started = await post(ok, "start", { to: "backend-impl", task: "long", repo: "api", name: "busy-acc" });
  const id = started.body.instance.workerId;
  const out = await post(ok, "accept", { instance: id, reason: "x" });
  assert.equal(out.status, 400);
  assert.match(out.body.invalid[0].reason, /running/);
});

test("a good start of an implementor is 201 with the instance", async () => {
  const out = await post(ok, "start", { to: "backend-impl", task: "build it", repo: "api", name: "fresh" });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const inst = out.body.instance;
  assert.ok(inst.workerId && inst.branch && inst.worktree);
  assert.equal(inst.repo, "api");
  assert.match(inst.baseCommit, /^[0-9a-f]{40}$/);
  const list = await call(base, "GET", `/api/protocol/lines/${ok}/workers`);
  const w = list.body.workers.find((x) => x.id === inst.workerId);
  assert.equal(w.node, "backend-impl");
  assert.equal(w.persona, "backend");
});

test("a start without a name gets a generated one, and a frontend node gets the frontend persona", async () => {
  const out = await post(ok, "start", { to: "frontend-impl", task: "ui", repo: "api" });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const list = await call(base, "GET", `/api/protocol/lines/${ok}/workers`);
  const w = list.body.workers.find((x) => x.id === out.body.instance.workerId);
  assert.equal(w.name, "frontend-impl-1");
  assert.equal(w.persona, "frontend");
});

test("a good start of a validator with criteria and source is 201", async () => {
  const out = await post(ok, "start", { to: "backend-val", criteria: "1. It works.", source: "i1" });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.ok(out.body.instance.validatorId);
  const list = await call(base, "GET", `/api/protocol/lines/${ok}/workers`);
  const w = list.body.workers.find((x) => x.id === out.body.instance.validatorId);
  assert.equal(w.node, "backend-val");
  assert.equal(w.validates, "i1");
});

// C3: values are checked against the line.
test("C3: a running instance cannot be the source of a validator", async () => {
  const started = await post(ok, "start", { to: "backend-impl", task: "long", repo: "api", name: "busy" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const out = await post(ok, "start", { to: "backend-val", criteria: "1. x", source: started.body.instance.workerId });
  assert.equal(out.status, 400);
  assert.equal(out.body.code, "INTERACTION_FIELDS");
  assert.equal(out.body.invalid.length, 1);
  assert.equal(out.body.invalid[0].field, "source");
  assert.match(out.body.invalid[0].reason, /running/);
});

test("C3: the source must belong to the node the validator checks", async () => {
  const out = await post(ok, "start", { to: "backend-val", criteria: "1. x", source: "f1" });
  assert.equal(out.status, 400);
  assert.match(out.body.invalid[0].reason, /belongs to node 'frontend-impl': expected backend-impl/);
  const unknown = await post(ok, "start", { to: "backend-val", criteria: "1. x", source: "ghost" });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.invalid[0].reason, /no such instance/);
});

test("C3: the repo must be registered on the line", async () => {
  const out = await post(ok, "start", { to: "backend-impl", task: "t", repo: "unregistered" });
  assert.equal(out.status, 400);
  assert.deepEqual(out.body.invalid, [{ field: "repo", reason: "not a registered repo of this line" }]);
});

test("C3: a commit field is checked against the repo of the call", async () => {
  const { checkLineValues } = require("../call-fields");
  const sha = git(src, "rev-parse", "HEAD");
  const required = { repo: { decl: { description: "r", type: "repo" }, requiredBy: "t" },
    rev: { decl: { description: "c", type: "commit" }, requiredBy: "t" } };
  const { spawnSync } = require("node:child_process");
  const line = { instance: () => undefined, hasRepo: (n) => n === "api",
    commitExists: (repo, c) => spawnSync("git", ["-C", src, "cat-file", "-e", `${c}^{commit}`]).status === 0 };
  assert.deepEqual(checkLineValues(line, required, { repo: "api", rev: sha }), []);
  assert.equal(checkLineValues(line, required, { repo: "api", rev: "c".repeat(40) }).length, 1);
});
