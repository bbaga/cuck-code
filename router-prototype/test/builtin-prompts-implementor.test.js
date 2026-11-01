"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadNodeType, resolveTypes } = require("../node-types");
const { render } = require("../template");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "server.js"), "utf8");

function slice(from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `marker "${from}" not found in server.js`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `marker "${to}" not found after "${from}"`);
  return source.slice(start, end);
}

// Build the old functions from the source text; requiring server.js starts the server.
const PORT = 7788;
const CHANGESET_LIMIT = 500;
const code = [
  slice("function frontendToolsBlock(", "\nconst { wrapPlannerTurn"),
  slice("const IMPL_PERSONA", "\nconst VAL_PERSONA"),
  slice("function containersBlock(", "function remoteBlockImplementor("),
  slice("function remoteBlockImplementor(", "function changesetBlock("),
  slice("function changesetBlock(", "function remoteBlockValidator("),
].join("\n");
const workerBrief = new Function("PORT", "CHANGESET_LIMIT", `${code}\nreturn workerBrief;`)(PORT, CHANGESET_LIMIT);

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

function oldText(persona, c) {
  return workerBrief("impl-1", "Line One", "Do the task.\nSecond line.", persona, "w-7", "line-9", c.repo,
    c.baseCommit, c.baseNote, c.ticket);
}

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
    test(`${typeName} renders the same text as workerBrief (${label})`, () => {
      assert.equal(newText(typeName, c), oldText(persona, c));
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
