"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { previewForLine, safeText } = require("../preview-instructions");

function line(worker, repoUrl) { return { ...(repoUrl === undefined ? {} : { repoUrl }), workers: new Map([[worker.id, worker]]) }; }
function repository(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preview-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  for (const [name, contents] of Object.entries(files)) {
    const fullPath = path.join(root, name);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, contents);
  }
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "-c", "user.email=a@b", "-c", "user.name=test", "commit", "-qm", "test"]);
  return { root, commit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
}
function validator(root, commit, changes = {}) { return { id: "x", role: "validator", kind: "integration", status: "completed", verdict: "pass", worktreePath: root, branch: "integration/x", validatedCommit: commit, ...changes }; }
function assertManualOnly(result) {
  assert.ok(result.steps.length > 0);
  assert.ok(result.steps.every(step => step.command === null));
  assert.deepEqual(result.instructions, result.steps);
  assert.equal(JSON.stringify(result).includes("[object Object]"), false);
}

test("only a completed integration PASS is eligible", () => {
  for (const changes of [{ status: "failed" }, { status: "stopped" }, { status: "running" }, { verdict: "fail" }, { kind: "standard" }]) {
    assert.equal(previewForLine(line({ ...validator("/missing", "a".repeat(40)), ...changes })).eligible, false);
  }
});
test("missing worktree reports unverified source", () => {
  const result = previewForLine(line(validator("/missing", "a".repeat(40))));
  assert.equal(result.verified, undefined);
  assert.equal(result.availability, "unavailable");
});
test("API response preserves structured steps and includes a pinned clone and detached checkout", t => {
  const { root, commit } = repository(t, { "app/package.json": JSON.stringify({ scripts: { start: "vite" }, dependencies: { vite: "1" } }), "app/package-lock.json": "{}", "app/.env.example": "SECRET=example", "app/README.md": "# Verification\nOpen http://localhost:4173 and confirm the preview page loads.\n- Submit a valid sample and confirm the result appears.\n" });
  const result = previewForLine(line(validator(root, commit), "https://example.com/team/project.git"));
  assert.equal(result.sourceRevision, commit);
  assert.equal(result.stack, "vite");
  assert.equal(result.directory, "app");
  assert.equal(result.steps.find(step => step.phase === "obtain").command.includes(commit), true);
  assert.match(result.steps.find(step => step.phase === "obtain").command, /git clone .* && git -C .* checkout --detach/);
  assert.ok(result.steps.some(step => step.phase === "install" && step.command === "cd 'cuck-code-" + commit.slice(0, 8) + "/app/' && npm ci"));
  assert.deepEqual(result.steps.map(step => step.phase), ["prepare", "obtain", "enter", "install", "run", "verify", "stop"]);
  assert.ok(result.steps.every(step => step.description && step.expected && typeof step.phase === "string" && (typeof step.command === "string" || step.command === null)));
  assert.match(result.steps.find(step => step.phase === "run").command, /cd .* && npm run start/);
  assert.match(result.steps.find(step => step.phase === "verify").description, /Submit a valid sample and confirm the result appears/);
  assert.match(result.steps.find(step => step.phase === "verify").expected, /require user confirmation/);
  assert.equal(result.expectedUrl, "http://localhost:4173");
  assert.ok(result.prerequisites.some(text => /unknown/.test(text)));
  assert.deepEqual(result.instructions, result.steps);
  assert.equal(JSON.stringify(result).includes("[object Object]"), false);
  assert.equal(result.steps.at(-1).command, null);
  execFileSync("git", ["-C", root, "checkout", "-qb", "advance"]);
  execFileSync("git", ["-C", root, "-c", "user.email=a@b", "-c", "user.name=test", "commit", "--allow-empty", "-qm", "advance"]);
  const advanced = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const again = previewForLine(line(validator(root, commit), "https://example.com/team/project.git"));
  assert.notEqual(advanced, commit);
  assert.equal(again.sourceRevision, commit);
  assert.deepEqual(again.steps, result.steps);
});
test("validated revision survives line-state JSON save and restore; old records stay unverified", () => {
  const worker = validator("/missing", "b".repeat(40));
  const saved = JSON.parse(JSON.stringify({ workers: [...line(worker).workers.values()].map(({ id, role, kind, status, verdict, validatedCommit }) => ({ id, role, kind, status, verdict, validatedCommit })) }));
  const restored = new Map(saved.workers.map(w => [w.id, w]));
  assert.equal(restored.get("x").validatedCommit, worker.validatedCommit);
  assert.equal(previewForLine(line({ id: "old", role: "validator", kind: "integration", status: "completed", verdict: "pass" })).stale, true);
});
test("unknown and ambiguous pinned project layouts give cautious guidance", t => {
  const { root, commit } = repository(t, { "README.md": "empty layout" });
  assert.equal(previewForLine(line(validator(root, commit))).stack, "unknown");
  fs.mkdirSync(path.join(root, "one"));
  fs.mkdirSync(path.join(root, "two"));
  fs.writeFileSync(path.join(root, "one", "package.json"), "{}");
  fs.writeFileSync(path.join(root, "two", "package.json"), "{}");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "-c", "user.email=a@b", "-c", "user.name=test", "commit", "-qm", "ambiguous"]);
  const ambiguous = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const result = previewForLine(line(validator(root, ambiguous)));
  assert.equal(result.stack, "unknown");
  assert.ok(result.limitations.some(text => text.includes("ambiguous")));
  assert.ok(result.steps.some(step => step.phase === "verify" && /What to verify:/.test(step.description) && /needs confirmation/.test(step.expected)));
  assert.ok(result.steps.every(step => step.command === null));
});
test("absent, conflicting, credential-bearing, and unsafe URLs return manual-only API guidance", t => {
  const { root, commit } = repository(t, { "package.json": JSON.stringify({ scripts: { start: "vite" }, dependencies: { vite: "1" } }), "package-lock.json": "{}" });
  const cases = [
    { line: line(validator(root, commit)), label: "absent" },
    { line: line(validator(root, commit, { repoUrl: "https://example.com/team/other.git" }), "https://example.com/team/project.git"), label: "conflicting" },
    { line: line(validator(root, commit), "https://user:secret@example.com/team/project.git"), label: "credential-bearing" },
    { line: line(validator(root, commit), "file:///tmp/project"), label: "unsafe scheme" },
    { line: line(validator(root, commit), "https://example.com/team/project.git?token=secret"), label: "query credential" }
  ];
  for (const { line: data, label } of cases) assertManualOnly(previewForLine(data), label);
});
test("sanitizer removes control characters and bounds content", () => {
  assert.equal(safeText("a\0b", 2), "ab");
});
