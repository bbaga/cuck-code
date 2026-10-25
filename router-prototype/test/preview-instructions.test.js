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
  const result = previewForLine(line({ id: "x", role: "validator", kind: "integration", status: "completed", verdict: "pass", worktreePath: "/missing", branch: "integration/x" }));
  assert.equal(result.verified, false);
});
test("recognized nested Node app pins source and emits safe numbered steps", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preview-test-"));
  try {
    const app = path.join(root, "app"); fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ scripts: { start: "vite" }, dependencies: { vite: "1" } }));
    fs.writeFileSync(path.join(app, ".env.example"), "SECRET=example");
    require("node:child_process").execFileSync("git", ["init", "-q", root]);
    require("node:child_process").execFileSync("git", ["-C", root, "checkout", "-qb", "integration/x"]);
    require("node:child_process").execFileSync("git", ["-C", root, "-c", "user.email=a@b", "-c", "user.name=test", "add", "."]);
    require("node:child_process").execFileSync("git", ["-C", root, "-c", "user.email=a@b", "-c", "user.name=test", "commit", "-qm", "test"]);
    const commit = require("node:child_process").execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const result = previewForLine(line({ id: "x", role: "validator", kind: "integration", status: "completed", verdict: "pass", worktreePath: root, branch: "integration/x" }));
    assert.equal(result.commit, commit); assert.equal(result.stack, "vite"); assert.equal(result.directory, "app");
    assert.ok(result.instructions.some((s) => s.includes("npm ci")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("sanitizer removes control characters and bounds content", () => {
  assert.equal(safeText("a\0b", 2), "ab");
});
