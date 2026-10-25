// Resolve the optional `base` of an implementor spawn to a full commit SHA.
// The git runner is injected: run(args) -> { status, stdout }, where args
// are the git arguments after `-C <repoPath>`.

const SHA_RE = /^[0-9a-f]{40}$/i;

class BaseError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function git(run, args) {
  try {
    const r = run(args);
    return r && typeof r.status === "number" ? r : { status: 1, stdout: "" };
  } catch {
    return { status: 1, stdout: "" };
  }
}

function revParseCommit(run, ref) {
  const r = git(run, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = r.status === 0 ? String(r.stdout || "").trim() : "";
  return SHA_RE.test(sha) ? sha.toLowerCase() : null;
}

function hasOrigin(run) {
  return git(run, ["remote", "get-url", "origin"]).status === 0;
}

// Returns null when no base was given, else { kind, sha, ref }.
// Throws BaseError(status, message) on rejection. It runs read-only
// git commands (fetch, rev-parse, cat-file) and never creates a worktree.
function resolveSpawnBase(base, { workers, repoName, run }) {
  if (base === undefined || base === null || base === "") return null;
  if (typeof base !== "string") {
    throw new BaseError(400, "base must be a 40-character commit SHA or an implementor name");
  }
  if (SHA_RE.test(base)) {
    const origin = hasOrigin(run);
    if (origin) git(run, ["fetch", "origin"]);
    const sha = base.toLowerCase();
    if (git(run, ["cat-file", "-e", `${sha}^{commit}`]).status !== 0) {
      throw new BaseError(404, `base commit ${sha} does not exist in repo '${repoName}'`);
    }
    return { kind: "sha", sha, ref: sha };
  }
  const target = [...workers].find((w) => w.name === base);
  if (!target && (/^[0-9a-f]+$/i.test(base) || /[\s:~^?*\[\\]/.test(base))) {
    throw new BaseError(400, "base must be a full 40-character commit SHA or an implementor name");
  }
  if (!target) throw new BaseError(404, `no worker named '${base}' in this line`);
  if (target.role !== "implementor") {
    throw new BaseError(400, `base worker '${base}' is not an implementor`);
  }
  if ((target.repo || "primary") !== repoName) {
    throw new BaseError(400, `base worker '${base}' belongs to repo '${target.repo || "primary"}', not '${repoName}'`);
  }
  if (target.status === "running") {
    throw new BaseError(409, `base worker '${base}' is running - wait for it to finish or stop it first`);
  }
  if (!target.branch) throw new BaseError(404, `base worker '${base}' has no branch`);
  let remoteSha = null;
  if (hasOrigin(run) && git(run, ["fetch", "origin", target.branch]).status === 0) {
    remoteSha = revParseCommit(run, `refs/remotes/origin/${target.branch}`);
  }
  if (remoteSha) return { kind: "worker", sha: remoteSha, ref: `origin/${target.branch}` };
  const localSha = revParseCommit(run, `refs/heads/${target.branch}`);
  if (!localSha) {
    throw new BaseError(404, `branch '${target.branch}' of worker '${base}' does not exist`);
  }
  return { kind: "worker", sha: localSha, ref: target.branch };
}

// Persisted and API-visible base fields of a worker record.
function baseFields(worker) {
  return { base: worker.base || null, baseResolved: worker.baseResolved || null };
}

function baseNote(base, resolved) {
  if (!resolved) return "";
  const who = resolved.kind === "worker" ? `the head of worker '${base}' (${resolved.ref}) ` : "";
  return `Your worktree starts at the base you were given: ${who}commit ${resolved.sha}.
The router counts your change set from this commit.
`;
}

module.exports = { BaseError, resolveSpawnBase, baseFields, baseNote };
