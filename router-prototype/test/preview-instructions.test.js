"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { previewForLine, safeText } = require("../preview-instructions");

function line(worker) { return { workers: new Map([[worker.id, worker]]) }; }
test("only a completed integration PASS is eligible", () => {
  for (const changes of [{ status: "failed" }, { status: "stopped" }, { status: "running" }, { verdict: "fail" }, { kind: "standard" }]) {
    const w = { id: "x", role: "validator", kind: "integration", status: "completed", verdict: "pass", ...changes };
    assert.equal(previewForLine(line(w)).eligible, false);
  }
});
test("missing worktree reports unverified source", () => {
  const result = previewForLine(line({ id: "x", role: "validator", kind: "integration", status: "completed", verdict: "pass", worktreePath: "/missing", branch: "integration/x", validatedCommit: "a".repeat(40) }));
  assert.equal(result.verified, undefined);
  assert.equal(result.availability, "unavailable");
});
test("recognized nested Node app pins source and emits safe numbered steps", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preview-test-"));
  try {
    const app = path.join(root, "app"); fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ scripts: { start: "vite" }, dependencies: { vite: "1" } }));
    fs.writeFileSync(path.join(app, "package-lock.json"), "{}");
    fs.writeFileSync(path.join(app, ".env.example"), "SECRET=example");
    require("node:child_process").execFileSync("git", ["init", "-q", root]);
    require("node:child_process").execFileSync("git", ["-C", root, "checkout", "-qb", "integration/x"]);
    require("node:child_process").execFileSync("git", ["-C", root, "-c", "user.email=a@b", "-c", "user.name=test", "add", "."]);
    require("node:child_process").execFileSync("git", ["-C", root, "-c", "user.email=a@b", "-c", "user.name=test", "commit", "-qm", "test"]);
    const commit = require("node:child_process").execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const result = previewForLine(line({ id: "x", role: "validator", kind: "integration", status: "completed", verdict: "pass", worktreePath: root, branch: "integration/x", validatedCommit: commit }));
    assert.equal(previewForLine(line({ id: "x", role: "validator", kind: "integration", status: "completed", verdict: "pass", worktreePath: root, branch: "integration/x", validatedCommit: commit })).sourceRevision, commit);
    assert.equal(result.sourceRevision, commit); assert.equal(result.stack, "vite"); assert.equal(result.directory, "app");
    assert.ok(result.instructions.some((s) => s.includes("npm ci")));
    const { execFileSync } = require("node:child_process");
    execFileSync("git", ["-C", root, "checkout", "-qb", "advance"]);
    execFileSync("git", ["-C", root, "-c", "user.email=a@b", "-c", "user.name=test", "commit", "--allow-empty", "-qm", "advance"]);
    const advanced = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const again = previewForLine(line({ id: "x", role: "validator", kind: "integration", status: "completed", verdict: "pass", worktreePath: root, branch: "integration/x", validatedCommit: commit }));
    assert.notEqual(advanced, commit);
    assert.equal(again.sourceRevision, commit);
    assert.deepEqual(again.steps, result.steps);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("sanitizer removes control characters and bounds content", () => {
  assert.equal(safeText("a\0b", 2), "ab");
});
