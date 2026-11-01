"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadNodeType, resolveTypes } = require("../node-types");
const { render } = require("../template");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "server.js"), "utf8");
const start = source.indexOf("function plannerBrief(");
const end = source.indexOf("\n}\n", start) + 3;
assert.ok(start >= 0 && end > start, "plannerBrief not found in server.js");
const WORKER_CAP = 8;
const plannerBrief = new Function("WORKER_CAP", `${source.slice(start, end)}\nreturn plannerBrief;`)(WORKER_CAP);

const dir = path.join(root, "node-types", "planner");
const loaded = loadNodeType(dir, (f) => fs.readFileSync(f, "utf8"));
const type = resolveTypes({ planner: loaded }).planner;

// The renderer keeps HTML comments; the test removes the protocol markers.
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->\n?/g, "");
const renderNew = (values) => stripComments(render(type.body, {
  router: { url: "http://localhost:7788", workerCap: WORKER_CAP },
  line: { name: "Alpha", id: "line-1" },
  ...values,
}));

test("planner header", () => {
  assert.equal(type.session, "resume");
  assert.equal(type.workspace, "coordinator");
  assert.equal(type.outcome, "none");
  assert.equal(type.coordinator, true);
  assert.deepEqual(Object.keys(type.fields).sort(), ["task", "trackerTicket"]);
  assert.equal(type.fields.trackerTicket.optional, true);
});

test("planner template equals plannerBrief without a tracker ticket", () => {
  const old = plannerBrief("Alpha", "line-1", "Build the thing.", 7788);
  assert.equal(renderNew({ task: "Build the thing." }).trimEnd(), old.trimEnd());
});

test("planner template equals plannerBrief with a tracker ticket", () => {
  const old = plannerBrief("Alpha", "line-1", "Build the thing.", 7788, "ABC-123");
  assert.equal(renderNew({ task: "Build the thing.", trackerTicket: "ABC-123" }).trimEnd(), old.trimEnd());
});

test("protocol markers wrap the factory protocol", () => {
  const b = type.body;
  const s = b.indexOf("<!-- protocol:start -->\n## Factory protocol");
  const e = b.indexOf("<!-- protocol:end -->");
  assert.ok(s >= 0 && e > s);
  assert.ok(b.slice(s, e).includes("6. Integration:"));
  assert.ok(b.slice(e).startsWith("<!-- protocol:end -->\n\n## Work registry"));
});
