"use strict";

// Router API: a line has no implicit repository. Repos are explicit, every
// worker names one, legacy lines adopt their workdir clone, and an
// integration starts only from accepted work.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startRouter, stopRouter } = require("./fixtures/router-process");

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
  { encoding: "utf8" }).trim();

function sourceRepo(root, name) {
  const dir = path.join(root, "src", name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, `${name}.txt`), name);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

async function call(base, method, pathname, body) {
  const res = await fetch(base + pathname, { method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let root, linesDir, router, base, legacyDir, approvedId;
test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "line-repos-api-"));
  linesDir = path.join(root, "lines");
  fs.mkdirSync(linesDir);
  // A line saved before repos were explicit: its workdir is a clone.
  const legacySrc = sourceRepo(root, "legacy");
  legacyDir = path.join(linesDir, "legacy-line");
  execFileSync("git", ["clone", "-q", legacySrc, legacyDir]);
  fs.writeFileSync(path.join(legacyDir, "line.json"), JSON.stringify({
    id: "legacy-line", name: "Legacy", repoUrl: legacySrc,
    workers: [{ id: "w1", name: "old", role: "implementor", status: "completed", branch: "b/old",
      worktreePath: path.join(linesDir, "worktrees", "legacy-line", "old") }] }));
  // An approved line whose only implementor has no validation decision yet.
  const apiSrc = sourceRepo(root, "api");
  approvedId = "approved-line";
  const approvedDir = path.join(linesDir, approvedId);
  fs.mkdirSync(approvedDir);
  const apiClone = path.join(approvedDir, "repos", "api");
  execFileSync("git", ["clone", "-q", apiSrc, apiClone]);
  fs.writeFileSync(path.join(approvedDir, "line.json"), JSON.stringify({
    id: approvedId, name: "Approved", layout: 2, started: true, planApproved: true,
    repos: [{ name: "api", url: apiSrc, path: apiClone }],
    workers: [{ id: "i1", name: "impl", role: "implementor", status: "completed", repo: "api", branch: "b/impl",
      runGeneration: 1, lastCompletedInvocationId: "inv-1",
      worktreePath: path.join(linesDir, "worktrees", approvedId, "api", "impl") }] }));
  router = await startRouter(linesDir, { ROUTER_ALLOW_LOCAL_REPOS: "1" });
  base = router.base;
});

test.after(async () => {
  if (router) await stopRouter(router);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a new line keeps code repos out of its workdir and registers each by name", async () => {
  const web = sourceRepo(root, "web");
  const created = await call(base, "POST", "/api/lines", { name: "Multi", repos: [{ url: web }, { name: "Docs", url: sourceRepo(root, "docs") }] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  const workdir = path.join(linesDir, id);
  assert.equal(fs.existsSync(path.join(workdir, "web.txt")), false, "the workdir is not a clone");
  assert.ok(fs.existsSync(path.join(workdir, ".git")), "the workdir is a git repo for plan.md");
  const repos = await call(base, "GET", `/api/protocol/lines/${id}/repos`);
  assert.deepEqual(repos.body.repos.map((r) => r.name), ["web", "docs"]);
  assert.ok(fs.existsSync(path.join(workdir, "repos", "web", "web.txt")));
  const added = await call(base, "POST", `/api/protocol/lines/${id}/repos`, { url: sourceRepo(root, "lib") });
  assert.equal(added.status, 201);
  assert.equal(added.body.name, "lib");
  const dup = await call(base, "POST", `/api/protocol/lines/${id}/repos`, { name: "web", url: web });
  assert.equal(dup.status, 409);
  const saved = JSON.parse(fs.readFileSync(path.join(workdir, "line.json"), "utf8"));
  assert.equal(saved.layout, 2);
  assert.equal("repoUrl" in saved, false);
});

test("the repoUrl shorthand registers one named repo, and a line may start with none", async () => {
  const one = await call(base, "POST", "/api/lines", { name: "One", repoUrl: sourceRepo(root, "shop") });
  assert.equal(one.status, 201);
  const repos = await call(base, "GET", `/api/protocol/lines/${one.body.id}/repos`);
  assert.deepEqual(repos.body.repos.map((r) => r.name), ["shop"]);
  const none = await call(base, "POST", "/api/lines", { name: "None" });
  assert.equal(none.status, 201);
  assert.deepEqual((await call(base, "GET", `/api/protocol/lines/${none.body.id}/repos`)).body.repos, []);
  const bad = await call(base, "POST", "/api/lines", { repos: [{ name: "x" }] });
  assert.equal(bad.status, 400);
});

test("a legacy line adopts its workdir clone as a named repo", async () => {
  const repos = await call(base, "GET", "/api/protocol/lines/legacy-line/repos");
  assert.equal(repos.status, 200);
  assert.deepEqual(repos.body.repos.map((r) => [r.name, r.path]), [["legacy", legacyDir]]);
});

test("spawning a worker requires a registered repo", async () => {
  const missing = await call(base, "POST", `/api/protocol/lines/${approvedId}/workers`, { name: "n", prompt: "p" });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /repo is required.*api/);
  const unknown = await call(base, "POST", `/api/protocol/lines/${approvedId}/workers`, { name: "n", prompt: "p", repo: "primary" });
  assert.equal(unknown.status, 404);
});

test("an integration is refused while an implementor has no accepted result", async () => {
  const out = await call(base, "POST", `/api/protocol/lines/${approvedId}/integration`, { prompt: "test all" });
  assert.equal(out.status, 409);
  assert.deepEqual(out.body.blockers, [{ workerId: "i1", name: "impl", reason: "awaiting-criteria" }]);
  assert.match(out.body.error, /implementor 'impl'/);
});

test("a claim stores the remote identity of a registered repo", async () => {
  const sha = "a".repeat(40);
  const ok = await call(base, "POST", `/api/registry/lines/${approvedId}/claims`, { title: "T", repo: "api", branch: "b", commit: sha });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.claim.repoName, "api");
  assert.match(ok.body.claim.repo, /^file:\/\/.*\/src\/api$/);
  const unknown = await call(base, "POST", `/api/registry/lines/${approvedId}/claims`, { title: "T", repo: "primary", branch: "b", commit: sha });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, "UNKNOWN_REPO");
});

test("a seeded implementor gets its node after the load and the API shows it", async () => {
  const list = await call(base, "GET", `/api/protocol/lines/${approvedId}/workers`);
  assert.equal(list.status, 200);
  assert.equal(list.body.workers.find((w) => w.id === "i1").node, "backend-impl");
  const legacy = await call(base, "GET", "/api/protocol/lines/legacy-line/workers");
  assert.equal(legacy.body.workers.find((w) => w.id === "w1").node, "backend-impl");
});
