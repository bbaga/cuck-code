"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const {
  repoNameFromUrl, uniqueRepoName, repoIdentity, adoptLegacyWorkdir,
  integrationSelection, afterGate, defaultBranchFrom, prepareIntegrationWorkspace,
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

test("integrationSelection includes implementors with a PASS or an accepted run for the latest run", () => {
  const a = impl("a");
  const b = impl("b", { acceptedRuns: [{ runId: 2, invocationId: "inv-b", by: "planner" }] });
  const out = integrationSelection([a, val(a), b, { id: "int", role: "validator", kind: "integration", status: "completed" }]);
  assert.deepEqual(out.included.map((w) => w.id), ["a", "b"]);
  assert.deepEqual(out.blockers, []);
});

test("integrationSelection blocks every implementor without accepted work for its latest run", () => {
  const running = impl("running", { status: "running" });
  const failed = impl("failed", { status: "failed" });
  const validating = impl("validating");
  const awaiting = impl("awaiting");
  const failing = impl("failing");
  const noVerdict = impl("noverdict");
  const stale = impl("stale");
  const oldAccept = impl("oldaccept", { acceptedRuns: [{ runId: 1, invocationId: "inv-old", by: "planner" }] });
  const workers = [running, failed, validating, val(validating, { status: "running", verdict: null }),
    awaiting, failing, val(failing, { verdict: "fail" }), noVerdict, val(noVerdict, { verdict: null }),
    // A PASS for an older run does not count after the implementor ran again.
    stale, val(stale, { validationSource: { workerId: "stale", runId: 1, invocationId: "inv-old" } }),
    oldAccept];
  const out = integrationSelection(workers);
  assert.deepEqual(out.included, []);
  assert.deepEqual(Object.fromEntries(out.blockers.map((b) => [b.workerId, b.reason])), {
    running: "running", failed: "not-completed", validating: "validation-running",
    awaiting: "awaiting-criteria", failing: "verdict-fail", noverdict: "verdict-missing",
    stale: "awaiting-criteria", oldaccept: "awaiting-criteria" });
  assert.match(out.blockers[0].text, /implementor 'running' \(running\) is still running/);
});

test("integrationSelection uses the latest validator for the run", () => {
  const a = impl("a");
  const out = integrationSelection([a, val(a, { n: 1, verdict: "fail" }), val(a, { n: 2, verdict: "pass" })]);
  assert.deepEqual(out.included.map((w) => w.id), ["a"]);
});

test("C5: integrationSelection accepts a run with an acceptedRuns entry, not an older one", () => {
  const rec = (runId, invocationId) => ({ runId, invocationId, by: "planner", reason: "r", at: "t" });
  const a = impl("a", { acceptedRuns: [rec(2, "inv-a")] });
  const old = impl("old", { acceptedRuns: [rec(1, "inv-old")] });
  const out = integrationSelection([a, old]);
  assert.deepEqual(out.included.map((w) => w.id), ["a"]);
  assert.deepEqual(out.blockers.map((b) => [b.workerId, b.reason]), [["old", "awaiting-criteria"]]);
});

test("C5: the workspace kind of the node decides which instances need acceptance", () => {
  const graph = { nodes: { w: { type: "t-own" }, c: { type: "t-co" }, s: { type: "t-src" } },
    types: { "t-own": { workspace: "own-worktree" }, "t-co": { workspace: "coordinator" }, "t-src": { workspace: "source" } } };
  const own = impl("own", { node: "w" });
  const coordinator = impl("co", { node: "c" });
  const checker = { id: "chk", role: "validator", node: "s", status: "completed", verdict: "pass" };
  const noNode = impl("nonode");
  const out = integrationSelection([own, coordinator, checker, noNode], graph);
  assert.deepEqual(out.blockers.map((b) => b.workerId), ["own", "nonode"]);
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

// ---- required checks and the after gate ----
const gateGraph = { types: { impl: { workspace: "own-worktree" }, chk: { runner: "script" }, val: {} },
  nodes: { api: { type: "impl" }, ci: { type: "chk", checks: ["api"], required: true },
    lint: { type: "chk", checks: ["api"] }, rev: { type: "val", checks: ["api"], after: ["ci", "lint"] },
    plain: { type: "val", checks: ["api"] } } };
const api = (extra = {}) => impl("a", { node: "api", ...extra });
const chk = (i, node, extra = {}) => val(i, { id: `${node}-${extra.n || 1}`, node, ...extra });

test("required check: missing, running, fail block; pass includes; accept does not bypass", () => {
  const a = api();
  const reasonOf = (...workers) => integrationSelection([a, ...workers], gateGraph).blockers.map((b) => b.reason);
  assert.deepEqual(reasonOf(), ["awaiting-criteria"]);
  // An LLM validator PASS or an accept does not replace the check.
  assert.deepEqual(reasonOf(val(a)), ["required-check-missing"]);
  const accepted = api({ acceptedRuns: [{ runId: 2, invocationId: "inv-a", by: "planner" }] });
  const out = integrationSelection([accepted], gateGraph);
  assert.deepEqual(out.blockers.map((b) => b.reason), ["required-check-missing"]);
  assert.match(out.blockers[0].text, /has no PASS from required check 'ci' on its latest run/);
  // The newest run is a PASS of another validator, so the failed check is the blocker.
  assert.deepEqual(reasonOf(chk(a, "ci", { verdict: "fail" }), val(a)), ["required-check-fail"]);
  assert.deepEqual(reasonOf(chk(a, "ci", { status: "failed", verdict: null }), val(a)), ["required-check-fail"]);
  const pass = integrationSelection([a, chk(a, "ci")], gateGraph);
  assert.deepEqual(pass.included.map((w) => w.id), ["a"]);
  const acceptedPass = integrationSelection([accepted, chk(accepted, "ci")], gateGraph);
  assert.deepEqual(acceptedPass.included.map((w) => w.id), ["a"]);
  // A PASS on an older run counts as missing.
  const old = chk(a, "ci", { validationSource: { workerId: "a", runId: 1, invocationId: "inv-old" } });
  assert.deepEqual(reasonOf(val(a), old), ["required-check-missing"]);
});

test("required check: a running check blocks; a node without required does not block", () => {
  const a = api();
  const running = integrationSelection([a, chk(a, "ci", { status: "running", verdict: null })], gateGraph);
  assert.equal(running.included.length, 0);
  assert.equal(running.blockers.length, 1);
  // 'lint' is not required: only the LLM-style PASS counts.
  const noRequired = { ...gateGraph, nodes: { ...gateGraph.nodes, ci: { type: "chk", checks: ["api"] } } };
  assert.deepEqual(integrationSelection([a, val(a)], noRequired).included.map((w) => w.id), ["a"]);
});

test("afterGate reports missing, running, fail and pass for each node in after", () => {
  const a = api();
  const gate = (...workers) => afterGate(workers, gateGraph, "rev", a);
  assert.deepEqual(gate(), { ok: false, passed: [],
    pending: [{ node: "ci", state: "missing" }, { node: "lint", state: "missing" }] });
  const mixed = gate(chk(a, "ci", { status: "running", verdict: null }), chk(a, "lint", { verdict: "fail" }));
  assert.deepEqual(mixed.pending, [{ node: "ci", state: "running" }, { node: "lint", state: "fail" }]);
  const old = chk(a, "ci", { validationSource: { workerId: "a", runId: 1, invocationId: "inv-old" } });
  assert.deepEqual(gate(old, chk(a, "lint")).pending, [{ node: "ci", state: "missing" }]);
  const ok = gate(chk(a, "ci"), chk(a, "lint"));
  assert.deepEqual(ok, { ok: true, pending: [], passed: ["ci-1", "lint-1"] });
  // The latest run of a node wins.
  assert.equal(gate(chk(a, "ci", { n: 1 }), chk(a, "ci", { n: 2, verdict: "fail" }), chk(a, "lint")).ok, false);
  assert.deepEqual(afterGate([], gateGraph, "plain", a), { ok: true, pending: [], passed: [] });
});
