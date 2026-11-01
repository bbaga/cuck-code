const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveSpawnBase, BaseError, baseFields, baseNote } = require("../spawn-base");

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const parent = { name: "parent", role: "implementor", repo: "web", branch: "9b508685/parent", status: "done" };

// Fake git: `ok` maps a joined arg string to stdout; others fail.
function runner(ok) {
  const calls = [];
  const run = (args) => {
    const key = args.join(" ");
    calls.push(key);
    return key in ok ? { status: 0, stdout: ok[key] } : { status: 1, stdout: "" };
  };
  return { run, calls };
}
const ctx = (run, workers = [parent]) => ({ workers, repoName: "web", run });
const rejects = (fn, status) => assert.throws(fn, (e) => e instanceof BaseError && e.status === status);

test("absent, null and empty base resolve to null without git calls", () => {
  for (const b of [undefined, null, ""]) {
    const { run, calls } = runner({});
    assert.equal(resolveSpawnBase(b, ctx(run)), null);
    assert.deepEqual(calls, []);
  }
});

test("a valid SHA is fetched and verified", () => {
  const { run, calls } = runner({ "remote get-url origin": "x", fetch: "", "fetch origin": "", [`cat-file -e ${SHA}^{commit}`]: "" });
  assert.deepEqual(resolveSpawnBase(SHA, ctx(run)), { kind: "sha", sha: SHA, ref: SHA });
  assert.ok(calls.includes("fetch origin"));
});

test("a SHA works without an origin remote", () => {
  const { run, calls } = runner({ [`cat-file -e ${SHA}^{commit}`]: "" });
  assert.equal(resolveSpawnBase(SHA, ctx(run)).sha, SHA);
  assert.ok(!calls.includes("fetch origin"));
});

test("a SHA still resolves when the fetch fails", () => {
  const { run } = runner({ "remote get-url origin": "x", [`cat-file -e ${SHA}^{commit}`]: "" });
  assert.equal(resolveSpawnBase(SHA, ctx(run)).sha, SHA);
});

test("an unknown SHA gives 404", () => {
  rejects(() => resolveSpawnBase(SHA, ctx(runner({}).run)), 404);
});

test("malformed values give 400", () => {
  for (const b of ["abc123", "no such:thing", "HEAD~1", 42, {}]) {
    rejects(() => resolveSpawnBase(b, ctx(runner({}).run)), 400);
  }
});

test("a worker name resolves through origin", () => {
  const { run } = runner({
    "remote get-url origin": "x", "fetch origin 9b508685/parent": "",
    "rev-parse --verify --quiet refs/remotes/origin/9b508685/parent^{commit}": SHA + "\n",
    "rev-parse --verify --quiet refs/heads/9b508685/parent^{commit}": OTHER + "\n",
  });
  assert.deepEqual(resolveSpawnBase("parent", ctx(run)),
    { kind: "worker", sha: SHA, ref: "origin/9b508685/parent" });
});

test("a failed fetch falls back to the local branch", () => {
  const { run } = runner({
    "remote get-url origin": "x",
    "rev-parse --verify --quiet refs/remotes/origin/9b508685/parent^{commit}": OTHER + "\n",
    "rev-parse --verify --quiet refs/heads/9b508685/parent^{commit}": SHA + "\n",
  });
  assert.deepEqual(resolveSpawnBase("parent", ctx(run)),
    { kind: "worker", sha: SHA, ref: "9b508685/parent" });
});

test("a missing remote branch falls back to the local branch", () => {
  const { run } = runner({
    "remote get-url origin": "x", "fetch origin 9b508685/parent": "",
    "rev-parse --verify --quiet refs/heads/9b508685/parent^{commit}": SHA + "\n",
  });
  assert.equal(resolveSpawnBase("parent", ctx(run)).ref, "9b508685/parent");
});

test("a worker without any branch commit gives 404", () => {
  rejects(() => resolveSpawnBase("parent", ctx(runner({}).run)), 404);
});

test("an unknown worker gives 404", () => {
  rejects(() => resolveSpawnBase("ghost", ctx(runner({}).run)), 404);
});

test("a validator gives 400", () => {
  const v = { ...parent, name: "val", role: "validator" };
  rejects(() => resolveSpawnBase("val", ctx(runner({}).run, [v])), 400);
});

test("a worker of another repository gives 400", () => {
  const w = { ...parent, repo: "other" };
  rejects(() => resolveSpawnBase("parent", ctx(runner({}).run, [w])), 400);
});

test("a worker without a repository is never treated as part of a named repo", () => {
  const w = { ...parent, repo: undefined };
  rejects(() => resolveSpawnBase("parent", ctx(runner({}).run, [w])), 400);
});

test("a running worker gives 409", () => {
  const w = { ...parent, status: "running" };
  rejects(() => resolveSpawnBase("parent", ctx(runner({}).run, [w])), 409);
});

test("rejections never run worktree add or branch creation", () => {
  const w = { ...parent, status: "running" };
  for (const [b, workers] of [[SHA, [parent]], ["ghost", [parent]], ["parent", [w]], ["x y", [parent]]]) {
    const { run, calls } = runner({});
    assert.throws(() => resolveSpawnBase(b, ctx(run, workers)), BaseError);
    assert.ok(!calls.some((c) => c.startsWith("worktree") || c.startsWith("branch")));
  }
});

test("baseFields and baseNote describe the base", () => {
  assert.deepEqual(baseFields({}), { base: null, baseResolved: null });
  assert.equal(baseNote("x", null), "");
  const note = baseNote("parent", { kind: "worker", sha: SHA, ref: "b" });
  assert.match(note, /parent/);
  assert.match(note, new RegExp(SHA));
  assert.match(baseNote(SHA, { kind: "sha", sha: SHA, ref: SHA }), /counts your change set/);
});
