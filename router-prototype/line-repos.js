"use strict";

// Repositories of a factory line. A line has no implicit repository: its
// workdir holds only the planner state (line.json, plan.md). Every code
// repository is registered by name; every implementor and validator works
// on exactly one of them. Only the integration validator spans repositories.

const REPO_NAME = /^[a-z0-9-]{1,64}$/;

function sanitizeRepoName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 64);
}

// "https://github.com/o/my-repo.git" -> "my-repo". Returns "" when nothing usable remains.
function repoNameFromUrl(url) {
  const trimmed = String(url || "").trim().replace(/[\\/]+$/, "").replace(/\.git$/i, "");
  const last = trimmed.split(/[\\/:]/).filter(Boolean).pop() || "";
  return sanitizeRepoName(last);
}

// A name that is not in `taken`: base, base-2, base-3, ...
function uniqueRepoName(base, taken) {
  const used = taken instanceof Set ? taken : new Set(taken || []);
  const root = sanitizeRepoName(base) || "repo";
  if (!used.has(root)) return root;
  for (let n = 2; ; n++) {
    const candidate = `${root}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

// A repository identity that is the same for every line: the normalized
// remote URL. GitHub SSH and HTTPS forms map to one value. A repository
// without a remote has no identity outside its line and returns null.
function repoIdentity(url) {
  if (typeof url !== "string" || !url.trim()) return null;
  let value = url.trim();
  const scp = value.match(/^([A-Za-z0-9_.-]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/);
  if (scp) value = `https://${scp[2]}/${scp[3]}`;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return null;
  const parts = parsed.pathname.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (!parsed.hostname || !parts.length) return null;
  return `https://${parsed.hostname.toLowerCase()}/${parts.join("/")}`;
}

// Migration of a line saved before repositories were explicit. Such a line
// used its workdir as the implicit "primary" repository. Adopt that clone
// in place as a named repository when the line used it: it was cloned from
// a URL, or a worker worked in it. Returns { adopted, repos, workerRepo }.
function adoptLegacyWorkdir(meta, workdir) {
  const repos = (meta && Array.isArray(meta.repos) ? meta.repos : [])
    .filter((r) => r && typeof r.name === "string")
    .map((r) => ({ name: r.name, url: r.url || null, path: r.path }));
  if (meta && meta.layout === 2) return { adopted: null, repos, workerRepo: null };
  const workers = meta && Array.isArray(meta.workers) ? meta.workers : [];
  const usedPrimary = workers.some((w) => w && w.kind !== "integration" && (!w.repo || w.repo === "primary"));
  if (!(meta && meta.repoUrl) && !usedPrimary) return { adopted: null, repos, workerRepo: null };
  const name = uniqueRepoName(repoNameFromUrl(meta && meta.repoUrl) || "workdir", repos.map((r) => r.name));
  const adopted = { name, url: (meta && meta.repoUrl) || null, path: workdir };
  return { adopted, repos: [adopted, ...repos], workerRepo: name };
}

const BLOCKER_TEXT = {
  running: "is still running",
  "not-completed": "did not complete (failed or stopped); continue it or remove it",
  "validation-queued": "has a validation waiting for a free slot",
  "validation-running": "has a validator that is still running",
  "awaiting-criteria": "has no validation decision for its latest run",
  "verdict-fail": "has VERDICT: FAIL for its latest run",
  "verdict-missing": "has a validation without a VERDICT line for its latest run",
};

// Decide which implementors enter an integration. The planner's call to
// start an integration is its acceptance of the validated work. Every
// implementor must have accepted work for its latest completed run: a
// validator with VERDICT: PASS for that run, or a SKIP VALIDATION decision
// for that run. Anything else blocks the integration.
// Returns { included: [worker], blockers: [{ workerId, name, reason, text }] }.
function integrationSelection(workers, pendingValidations = []) {
  const all = [...workers];
  const implementors = all.filter((w) => w.role === "implementor" && w.kind !== "integration");
  const included = [];
  const blockers = [];
  const block = (w, reason) => blockers.push({ workerId: w.id, name: w.name, reason,
    text: `implementor '${w.name}' (${w.id}) ${BLOCKER_TEXT[reason]}` });
  for (const impl of implementors) {
    if (impl.status === "running" || impl.child) { block(impl, "running"); continue; }
    if (impl.status !== "completed") { block(impl, "not-completed"); continue; }
    if ((pendingValidations || []).some((p) => p && p.implWorkerId === impl.id)) { block(impl, "validation-queued"); continue; }
    const validators = all.filter((v) => v.role === "validator" && v.validates === impl.id);
    if (validators.some((v) => v.status === "running")) { block(impl, "validation-running"); continue; }
    const current = (src) => src && src.runId === impl.runGeneration
      && src.invocationId === impl.lastCompletedInvocationId;
    if (current(impl.validationSkipped)) { included.push(impl); continue; }
    const latest = validators.filter((v) => current(v.validationSource)).pop();
    if (!latest) { block(impl, "awaiting-criteria"); continue; }
    if (latest.status === "completed" && latest.verdict === "pass") { included.push(impl); continue; }
    block(impl, latest.status === "completed" && latest.verdict === "fail" ? "verdict-fail" : "verdict-missing");
  }
  return { included, blockers };
}

// Parse `git ls-remote --symref origin HEAD` output into a branch name.
function defaultBranchFrom(lsRemote) {
  const m = String(lsRemote || "").match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m);
  return m ? m[1] : null;
}

// Prepare the integration workspace: one worktree per repository that has
// included branches, each on a fresh integration branch from that
// repository's current default branch. Records the exact commits.
// run(cwd, args) -> { status, stdout, stderr } runs git. Never throws.
// Returns { ok: true, repos: [manifest] } or { ok: false, error, stderr }.
function prepareIntegrationWorkspace({ repos, entries, root, branch, run, path }) {
  const created = [];
  const rollback = () => {
    for (const c of created.reverse()) {
      run(c.repoPath, ["worktree", "remove", "--force", c.worktreePath]);
      run(c.repoPath, ["branch", "-D", branch]);
    }
  };
  const fail = (error, stderr = "") => { rollback(); return { ok: false, error, stderr: String(stderr || "").slice(0, 2000) }; };
  const out = [];
  const byRepo = new Map();
  for (const e of entries) {
    if (!byRepo.has(e.repo)) byRepo.set(e.repo, []);
    byRepo.get(e.repo).push(e);
  }
  for (const [name, list] of byRepo) {
    const repo = repos.find((r) => r.name === name);
    if (!repo) return fail(`repo '${name}' is not registered on this line`);
    const ok = (args) => run(repo.path, args);
    let baseBranch = null;
    let baseRef;
    const remote = ok(["remote", "get-url", "origin"]);
    if (remote.status === 0 && String(remote.stdout).trim()) {
      const fetch = ok(["fetch", "--prune", "origin"]);
      if (fetch.status !== 0) return fail(`git fetch failed in repo '${name}'`, fetch.stderr);
      baseBranch = defaultBranchFrom(ok(["ls-remote", "--symref", "origin", "HEAD"]).stdout);
      if (!baseBranch) return fail(`cannot resolve the default branch of repo '${name}'`);
      baseRef = `refs/remotes/origin/${baseBranch}`;
    } else {
      const head = ok(["symbolic-ref", "--short", "HEAD"]);
      baseBranch = head.status === 0 ? String(head.stdout).trim() : null;
      baseRef = "HEAD";
    }
    const base = ok(["rev-parse", "--verify", `${baseRef}^{commit}`]);
    if (base.status !== 0) return fail(`cannot resolve the base commit of repo '${name}'`, base.stderr);
    const baseSha = String(base.stdout).trim();
    const branches = [];
    for (const e of list) {
      const head = ok(["rev-parse", "--verify", `refs/heads/${e.branch}^{commit}`]);
      if (head.status !== 0) return fail(`branch '${e.branch}' is missing in repo '${name}'`, head.stderr);
      branches.push({ workerId: e.workerId, name: e.name, branch: e.branch, sha: String(head.stdout).trim() });
    }
    const worktreePath = path.join(root, name);
    const wt = ok(["worktree", "add", "-b", branch, worktreePath, baseSha]);
    if (wt.status !== 0) return fail(`git worktree add failed in repo '${name}'`, wt.stderr);
    created.push({ repoPath: repo.path, worktreePath });
    out.push({ name, url: repo.url || null, repoPath: repo.path, worktreePath,
      baseBranch, baseSha, branches, validatedCommit: null });
  }
  return { ok: true, repos: out, rollback };
}

module.exports = {
  REPO_NAME,
  sanitizeRepoName,
  repoNameFromUrl,
  uniqueRepoName,
  repoIdentity,
  adoptLegacyWorkdir,
  integrationSelection,
  defaultBranchFrom,
  prepareIntegrationWorkspace,
};
