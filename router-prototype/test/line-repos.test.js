"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const {
  repoNameFromUrl, uniqueRepoName, repoIdentity, adoptLegacyWorkdir,
  integrationSelection, defaultBranchFrom, prepareIntegrationWorkspace,
} = require("../line-repos");

test("repoNameFromUrl derives a safe name from common URL forms", () => {
  assert.equal(repoNameFromUrl("https://github.com/o/My_Repo.git"), "myrepo");
  assert.equal(repoNameFromUrl("git@github.com:o/web-app.git"), "web-app");
  assert.equal(repoNameFromUrl("/tmp/src/api/"), "api");
  assert.equal(repoNameFromUrl(""), "");
});

test("uniqueRepoName adds a numeric suffix on collision", () => {
  assert.equal(uniqueRepoName("web", []), "web");
  assert.equal(uniqueRepoName("web", ["web", "web-2"]), "web-3");
  assert.equal(uniqueRepoName("", []), "repo");
});

test("repoIdentity maps SSH and HTTPS forms of one remote to one value", () => {
  const id = "https://github.com/o/r";
  assert.equal(repoIdentity("git@github.com:o/r.git"), id);
  assert.equal(repoIdentity("https://github.com/o/r.git"), id);
  assert.equal(repoIdentity("https://GitHub.com/o/r"), id);
  assert.equal(repoIdentity("ssh://git@github.com/o/r.git"), id);
  assert.equal(repoIdentity("https://gitlab.example.com/g/sub/r.git"), "https://gitlab.example.com/g/sub/r");
  assert.equal(repoIdentity("/local/path"), null);
  assert.equal(repoIdentity("file:///local/path"), null);
  assert.equal(repoIdentity(null), null);
});

test("adoptLegacyWorkdir adopts the implicit primary clone in place", () => {
  const meta = { repoUrl: "https://github.com/o/shop.git", repos: [{ name: "shop", url: "u", path: "/x" }],
    workers: [{ id: "w", role: "implementor" }, { id: "v", role: "validator", repo: "primary" }] };
  const out = adoptLegacyWorkdir(meta, "/lines/l1");
  assert.deepEqual(out.adopted, { name: "shop-2", url: "https://github.com/o/shop.git", path: "/lines/l1" });
  assert.equal(out.workerRepo, "shop-2");
  assert.deepEqual(out.repos.map((r) => r.name), ["shop-2", "shop"]);
});

test("adoptLegacyWorkdir adopts a local workdir that workers used, and skips unused ones", () => {
  const used = adoptLegacyWorkdir({ workers: [{ id: "w", role: "implementor", repo: "primary" }] }, "/l");
  assert.equal(used.adopted.name, "workdir");
  assert.equal(used.adopted.url, null);
  const unused = adoptLegacyWorkdir({ workers: [{ id: "w", role: "implementor", repo: "api" }],
    repos: [{ name: "api", path: "/a" }] }, "/l");
  assert.equal(unused.adopted, null);
  assert.deepEqual(unused.repos.map((r) => r.name), ["api"]);
  const current = adoptLegacyWorkdir({ layout: 2, repoUrl: "https://github.com/o/r", workers: [] }, "/l");
  assert.equal(current.adopted, null);
});

const impl = (id, extra = {}) => ({ id, name: id, role: "implementor", kind: "standard", status: "completed",
  runGeneration: 2, lastCompletedInvocationId: `inv-${id}`, repo: "web", branch: `b/${id}`, ...extra });
const val = (impl, extra = {}) => ({ id: `v-${impl.id}-${extra.n || 1}`, role: "validator", validates: impl.id,
  status: "completed", verdict: "pass",
  validationSource: { workerId: impl.id, runId: impl.runGeneration, invocationId: impl.lastCompletedInvocationId }, ...extra });

test("integrationSelection includes implementors with a PASS or a SKIP for the latest run", () => {
  const a = impl("a");
  const b = impl("b", { validationSkipped: { runId: 2, invocationId: "inv-b" } });
  const out = integrationSelection([a, val(a), b, { id: "int", role: "validator", kind: "integration", status: "completed" }]);
  assert.deepEqual(out.included.map((w) => w.id), ["a", "b"]);
  assert.deepEqual(out.blockers, []);
});

test("integrationSelection blocks every implementor without accepted work for its latest run", () => {
  const running = impl("running", { status: "running" });
  const failed = impl("failed", { status: "failed" });
  const queued = impl("queued");
  const validating = impl("validating");
  const awaiting = impl("awaiting");
  const failing = impl("failing");
  const noVerdict = impl("noverdict");
  const stale = impl("stale");
  const oldSkip = impl("oldskip", { validationSkipped: { runId: 1, invocationId: "inv-old" } });
  const workers = [running, failed, queued, validating, val(validating, { status: "running", verdict: null }),
    awaiting, failing, val(failing, { verdict: "fail" }), noVerdict, val(noVerdict, { verdict: null }),
    // A PASS for an older run does not count after the implementor ran again.
    stale, val(stale, { validationSource: { workerId: "stale", runId: 1, invocationId: "inv-old" } }),
    oldSkip];
  const out = integrationSelection(workers, [{ implWorkerId: "queued" }]);
  assert.deepEqual(out.included, []);
  assert.deepEqual(Object.fromEntries(out.blockers.map((b) => [b.workerId, b.reason])), {
    running: "running", failed: "not-completed", queued: "validation-queued", validating: "validation-running",
    awaiting: "awaiting-criteria", failing: "verdict-fail", noverdict: "verdict-missing",
    stale: "awaiting-criteria", oldskip: "awaiting-criteria" });
  assert.match(out.blockers[0].text, /implementor 'running' \(running\) is still running/);
});

test("integrationSelection uses the latest validator for the run", () => {
  const a = impl("a");
  const out = integrationSelection([a, val(a, { n: 1, verdict: "fail" }), val(a, { n: 2, verdict: "pass" })]);
  assert.deepEqual(out.included.map((w) => w.id), ["a"]);
});

test("defaultBranchFrom parses ls-remote --symref output", () => {
  assert.equal(defaultBranchFrom("ref: refs/heads/trunk\tHEAD\nabc\tHEAD\n"), "trunk");
  assert.equal(defaultBranchFrom(""), null);
});

// --- real git ---

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
  { encoding: "utf8" }).trim();
const run = (cwd, args) => {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

// An upstream with a default branch, cloned as the line's repo. Returns { upstream, clone }.
function remoteRepo(root, name, defaultBranch) {
  const upstream = path.join(root, `${name}-upstream`);
  fs.mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", defaultBranch);
  fs.writeFileSync(path.join(upstream, "README"), name);
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "init");
  const clone = path.join(root, "line", "repos", name);
  execFileSync("git", ["clone", "-q", upstream, clone]);
  return { upstream, clone };
}

function featureBranch(repoPath, branch, file) {
  git(repoPath, "branch", branch);
  const wt = `${repoPath}-wt-${branch.replace(/\W/g, "")}`;
  git(repoPath, "worktree", "add", "-q", wt, branch);
  fs.writeFileSync(path.join(wt, file), file);
  git(wt, "add", ".");
  git(wt, "commit", "-qm", file);
  return git(wt, "rev-parse", "HEAD");
}

test("prepareIntegrationWorkspace records the fetched default branch and the exact branch commits per repo", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "line-repos-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const web = remoteRepo(root, "web", "main");
  const api = remoteRepo(root, "api", "trunk");
  const webA = featureBranch(web.clone, "feat/a", "a.txt");
  const apiB = featureBranch(api.clone, "feat/b", "b.txt");
  // Work merged upstream after the line cloned: the integration base must include it.
  fs.writeFileSync(path.join(web.upstream, "later.txt"), "later");
  git(web.upstream, "add", ".");
  git(web.upstream, "commit", "-qm", "later");
  const upstreamHead = git(web.upstream, "rev-parse", "HEAD");
  // A repo with no included branch gets no worktree.
  const unused = remoteRepo(root, "docs", "main");

  const out = prepareIntegrationWorkspace({
    repos: [{ name: "web", path: web.clone, url: web.upstream }, { name: "api", path: api.clone, url: api.upstream },
      { name: "docs", path: unused.clone, url: unused.upstream }],
    entries: [{ workerId: "w1", name: "impl-a", repo: "web", branch: "feat/a" },
      { workerId: "w2", name: "impl-b", repo: "api", branch: "feat/b" }],
    root: path.join(root, "int"), branch: "integration/x", run, path,
  });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.repos.map((r) => r.name), ["web", "api"]);
  const [w, a] = out.repos;
  assert.equal(w.baseBranch, "main");
  assert.equal(w.baseSha, upstreamHead);
  assert.equal(a.baseBranch, "trunk");
  assert.deepEqual(w.branches, [{ workerId: "w1", name: "impl-a", branch: "feat/a", sha: webA }]);
  assert.deepEqual(a.branches, [{ workerId: "w2", name: "impl-b", branch: "feat/b", sha: apiB }]);
  assert.equal(w.worktreePath, path.join(root, "int", "web"));
  assert.equal(git(w.worktreePath, "rev-parse", "HEAD"), upstreamHead);
  assert.equal(git(w.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"), "integration/x");
  assert.ok(fs.existsSync(path.join(w.worktreePath, "later.txt")));
  assert.equal(fs.existsSync(path.join(root, "int", "docs")), false);
  // The recorded commit is pinned: a later commit on the branch is not the recorded one.
  git(web.clone + "-wt-feata", "commit", "--allow-empty", "-qm", "after start");
  assert.notEqual(git(web.clone, "rev-parse", "feat/a"), w.branches[0].sha);
});

test("prepareIntegrationWorkspace uses HEAD for a repo without a remote", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "line-repos-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const local = path.join(root, "local");
  fs.mkdirSync(local);
  git(local, "init", "-q", "-b", "dev");
  git(local, "commit", "--allow-empty", "-qm", "init");
  const head = git(local, "rev-parse", "HEAD");
  featureBranch(local, "feat/l", "l.txt");
  const out = prepareIntegrationWorkspace({ repos: [{ name: "local", path: local, url: null }],
    entries: [{ workerId: "w", name: "l", repo: "local", branch: "feat/l" }],
    root: path.join(root, "int"), branch: "integration/y", run, path });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.repos[0].baseBranch, "dev");
  assert.equal(out.repos[0].baseSha, head);
});

test("prepareIntegrationWorkspace rolls back created worktrees when a later repo fails", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "line-repos-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const web = remoteRepo(root, "web", "main");
  const api = remoteRepo(root, "api", "main");
  featureBranch(web.clone, "feat/a", "a.txt");
  const out = prepareIntegrationWorkspace({
    repos: [{ name: "web", path: web.clone, url: web.upstream }, { name: "api", path: api.clone, url: api.upstream }],
    entries: [{ workerId: "w1", name: "a", repo: "web", branch: "feat/a" },
      { workerId: "w2", name: "b", repo: "api", branch: "feat/missing" }],
    root: path.join(root, "int"), branch: "integration/z", run, path,
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /branch 'feat\/missing' is missing in repo 'api'/);
  assert.equal(fs.existsSync(path.join(root, "int", "web")), false);
  assert.equal(run(web.clone, ["rev-parse", "--verify", "refs/heads/integration/z"]).status === 0, false);
});

test("prepareIntegrationWorkspace refuses an unregistered repo", () => {
  const out = prepareIntegrationWorkspace({ repos: [], entries: [{ repo: "ghost", branch: "b" }],
    root: "/nowhere", branch: "integration/q", run: () => ({ status: 0, stdout: "" }), path });
  assert.equal(out.ok, false);
  assert.match(out.error, /repo 'ghost' is not registered/);
});
