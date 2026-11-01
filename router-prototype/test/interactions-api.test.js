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
const post = (line, name, body) => call(base, "POST", `/api/protocol/lines/${line}/interactions/${name}`, body);

function seedLine(linesDir, id, planApproved) {
  const lineDir = path.join(linesDir, id);
  fs.mkdirSync(lineDir);
  const clone = path.join(lineDir, "repos", "api");
  execFileSync("git", ["clone", "-q", src, clone]);
  const worker = (wid, name, node) => ({ id: wid, name, node, role: "implementor", status: "completed",
    repo: "api", branch: `b/${name}`, runGeneration: 1, lastCompletedInvocationId: `inv-${wid}`,
    lastRunText: `report of ${name}`,
    worktreePath: path.join(linesDir, "worktrees", id, "api", name) });
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
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  for (const agent of ["claude", "vibe", "codex", "pi"]) {
    fs.writeFileSync(path.join(bin, agent), "#!/bin/sh\nsleep 60\n");
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

test("a good call of an interaction without an implementation answers 501", async () => {
  const out = await post(ok, "feedback", { instance: "i1", instructions: "x" });
  assert.equal(out.status, 501);
  assert.equal(out.body.code, "NOT_IMPLEMENTED");
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
