"use strict";

// The creation paths were moved into functions. The HTTP responses must be
// exactly what the handlers sent before.
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

let root, router, base;
const lineId = "creation-line";
test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "instance-creation-"));
  const linesDir = path.join(root, "lines");
  fs.mkdirSync(linesDir);
  const src = path.join(root, "src", "api");
  fs.mkdirSync(src, { recursive: true });
  git(src, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(src, "a.txt"), "a");
  git(src, "add", ".");
  git(src, "commit", "-qm", "init");
  const lineDir = path.join(linesDir, lineId);
  fs.mkdirSync(lineDir);
  const clone = path.join(lineDir, "repos", "api");
  execFileSync("git", ["clone", "-q", src, clone]);
  fs.writeFileSync(path.join(lineDir, "line.json"), JSON.stringify({
    id: lineId, name: "Creation", layout: 2, started: true, planApproved: true,
    repos: [{ name: "api", url: src, path: clone }],
    workers: [{ id: "i1", name: "impl", role: "implementor", status: "completed", repo: "api", branch: "b/impl",
      runGeneration: 1, lastCompletedInvocationId: "inv-1",
      worktreePath: path.join(linesDir, "worktrees", lineId, "api", "impl") }] }));
  router = await startRouter(linesDir, { ROUTER_ALLOW_LOCAL_REPOS: "1" });
  base = router.base;
});

test.after(async () => {
  if (router) await stopRouter(router);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a worker spawn on a registered repo answers with the creation keys", async () => {
  const out = await call(base, "POST", `/api/protocol/lines/${lineId}/workers`,
    { name: "fresh", prompt: "do it", repo: "api" });
  assert.equal(out.status, 201);
  for (const key of ["workerId", "branch", "worktree", "repo", "baseCommit"]) {
    assert.ok(key in out.body, `missing ${key}`);
  }
  assert.equal(out.body.repo, "api");
  assert.match(out.body.baseCommit, /^[0-9a-f]{40}$/);
});

test("a spawn with an unknown repo is still 404", async () => {
  const out = await call(base, "POST", `/api/protocol/lines/${lineId}/workers`,
    { name: "other", prompt: "p", repo: "nope" });
  assert.equal(out.status, 404);
  assert.match(out.body.error, /no such repo: 'nope'/);
});

test("an integration with unaccepted work is still 409 with blockers", async () => {
  const out = await call(base, "POST", `/api/protocol/lines/${lineId}/integration`, { prompt: "test all" });
  assert.equal(out.status, 409);
  assert.ok(Array.isArray(out.body.blockers) && out.body.blockers.length > 0);
  assert.match(out.body.error, /^not all implementor work is accepted: /);
});
