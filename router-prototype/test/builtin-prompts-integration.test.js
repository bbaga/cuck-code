"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadNodeType, resolveTypes } = require("../node-types");
const { render } = require("../template");

const { golden } = require("./fixtures/golden-file");

const root = path.join(__dirname, "..");

const dir = path.join(root, "node-types", "integration-validator");
const readFile = (f) => fs.readFileSync(f, "utf8");
const type = loadNodeType(dir, readFile);

const manifest = [
  { name: "web", url: "https://github.com/o/web.git", worktreePath: "/wt/int/web", baseBranch: "main", baseSha: "a".repeat(40),
    branches: [{ name: "impl-a", branch: "feat/a", sha: "b".repeat(40) }, { name: "impl-b", branch: "feat/b", sha: "c".repeat(40) }] },
  { name: "api", url: null, worktreePath: "/wt/int/api", baseBranch: "master", baseSha: "d".repeat(40),
    branches: [{ name: "impl-c", branch: "feat/c", sha: "e".repeat(40) }, { name: "impl-d", branch: "feat/d", sha: "f".repeat(40) },
      { name: "impl-e", branch: "feat/e", sha: "1".repeat(40) }] },
  { name: "docs", url: "https://example.com/docs.git", worktreePath: "/wt/int/docs", baseBranch: null, baseSha: "2".repeat(40),
    branches: [{ name: "impl-f", branch: "feat/f", sha: "3".repeat(40) }] },
];

function values(manifestIn, instructions, line, workerId, branch) {
  return {
    line: { id: line.id, name: line.name },
    instance: { id: workerId },
    router: { url: "http://localhost:7788" },
    integration: {
      branch,
      repos: manifestIn.map((r) => ({
        name: r.name, url: r.url, worktreePath: r.worktreePath, baseBranch: r.baseBranch || "HEAD", baseSha: r.baseSha,
        branches: r.branches,
      })),
    },
    instructions,
  };
}

test("header of the integration-validator type", () => {
  assert.equal(type.name, "integration-validator");
  assert.equal(type.session, "fresh");
  assert.equal(type.workspace, "integration");
  assert.equal(type.outcome, "verdict");
  assert.equal(type.coordinator, false);
  assert.deepEqual(type.requires, ["accepted-work"]);
  assert.equal(type.fields.instructions.type, "text");
  assert.deepEqual(Object.keys(type.fields), ["instructions"]);
});

test("the type resolves: only instructions is a declared field", () => {
  const resolved = resolveTypes({ "integration-validator": type });
  assert.deepEqual(Object.keys(resolved["integration-validator"].fields), ["instructions"]);
});

// The golden files hold the output of the removed integrationValidatorBrief() for the same
// inputs (one-off script run before D9 removed the function).
test("new template renders exactly the golden text of the old integrationValidatorBrief", () => {
  const line = { id: "line-42", name: "Demo" };
  const old = golden("integration-three-repositories");
  const neu = render(type.body, values(manifest, "Merge it\nthen test it", line, "worker-1", "integration/x-1"));
  assert.equal(neu, old);
  assert.match(neu, /Repository 'api' \(no remote\)/);
  assert.match(neu, /created from HEAD at 2{40}/);
});

test("equality with the golden text holds for a single repository with one branch", () => {
  const one = [manifest[0]].map((r) => ({ ...r, branches: [r.branches[0]] }));
  const line = { id: "L", name: "N" };
  assert.equal(render(type.body, values(one, "x", line, "w", "integration/y")),
    golden("integration-single-repository"));
});
