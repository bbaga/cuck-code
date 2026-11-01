"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadNodeType, resolveTypes } = require("../node-types");
const { render } = require("../template");

const { golden, slug } = require("./fixtures/golden-file");

const root = path.join(__dirname, "..");
const PORT = 7788;
const CHANGESET_LIMIT = 500;

const types = {};
for (const name of ["implementor", "backend-implementor", "frontend-implementor"]) {
  types[name] = loadNodeType(`node-types/${name}`, (f) => fs.readFileSync(path.join(root, f), "utf8"));
}
const resolved = resolveTypes(types);

const CASES = {
  "no remote": { repo: { name: "app" }, ticket: undefined, baseNote: "", baseCommit: "abc123" },
  "remote": { repo: { name: "app", url: "git@example.com:org/app.git" }, ticket: undefined, baseNote: "Base note.\n", baseCommit: "abc123" },
  "tracker ticket": { repo: { name: "web", url: "https://example.com/org/web.git" }, ticket: "ABC-42", baseNote: "", baseCommit: undefined },
};

function newText(typeName, c) {
  const values = {
    line: { id: "line-9", name: "Line One", changesetLimit: String(CHANGESET_LIMIT) },
    instance: { id: "w-7", name: "impl-1", baseCommit: c.baseCommit || "unknown", baseNote: c.baseNote || "" },
    repo: c.repo,
    router: { url: `http://localhost:${PORT}` },
    task: "Do the task.\nSecond line.",
  };
  if (c.ticket) values.trackerTicket = c.ticket;
  return render(resolved[typeName].body, values);
}

for (const [persona, typeName] of [["backend", "backend-implementor"], ["frontend", "frontend-implementor"]]) {
  for (const [label, c] of Object.entries(CASES)) {
    // The golden files hold the output of the removed workerBrief() for the same inputs
    // (one-off script run before D9 removed the function).
    test(`${typeName} renders the golden text of the old workerBrief (${label})`, () => {
      assert.equal(newText(typeName, c), golden(`implementor-${persona}-${slug(label)}`));
    });
  }
}

test("implementor headers", () => {
  const i = resolved.implementor;
  assert.equal(i.session, "resume");
  assert.equal(i.workspace, "own-worktree");
  assert.equal(i.outcome, "none");
  assert.equal(i.coordinator, false);
  for (const name of ["backend-implementor", "frontend-implementor"]) {
    assert.equal(resolved[name].extends, "implementor");
    assert.equal(resolved[name].workspace, "own-worktree");
    assert.deepEqual(Object.keys(resolved[name].fields).sort(), ["task", "trackerTicket"]);
  }
});
