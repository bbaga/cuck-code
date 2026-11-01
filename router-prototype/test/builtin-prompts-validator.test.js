"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadNodeType, resolveTypes } = require("../node-types");
const { render, placeholders } = require("../template");
const { checkValues } = require("../fields");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "server.js"), "utf8");

// Cut a piece of server.js source text from `from` up to (not including) `to`.
function cut(from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `marker "${from}" not found in server.js`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `marker "${to}" not found after "${from}"`);
  return source.slice(start, end);
}

// server.js starts a server when required: build the old functions from source.
const PORT = 7788;
const oldSource = [
  cut("function frontendToolsBlock(", "\nconst { wrapPlannerTurn }"),
  cut("const VAL_PERSONA", "\nfunction containersBlock"),
  cut("function containersBlock(", "\nfunction remoteBlockImplementor"),
  cut("function remoteBlockValidator(", "\nfunction validatorBrief"),
  cut("function validatorBrief(", "\n\n\n// manifest:"),
].join("\n");
const validationCriteriaBlock = (criteria) => `The planner gave these acceptance criteria:\n${criteria}`;
const { validatorBrief } = new Function("PORT", "validationCriteriaBlock",
  `${oldSource}\nreturn { validatorBrief };`)(PORT, validationCriteriaBlock);

const types = {};
for (const name of ["validator", "backend-validator", "frontend-validator"]) {
  types[name] = loadNodeType(path.join(root, "node-types", name), (f) => fs.readFileSync(f, "utf8"));
}
const resolved = resolveTypes(types);

function newBrief(persona, a) {
  const values = {
    line: { id: a.lineId },
    instance: { id: a.workerId },
    source: { name: a.implName, id: a.implId, report: a.report },
    router: { url: `http://localhost:${PORT}` },
    repo: {},
    criteria: a.criteria,
  };
  if (a.repoName) values.repo.name = a.repoName;
  if (a.repoUrl) values.repo.url = a.repoUrl;
  if (a.trackerTicket) values.trackerTicket = a.trackerTicket;
  return render(resolved[`${persona}-validator`].body, values);
}

const base = {
  implName: "impl-a", report: "Done.\nTests pass.", criteria: "1. It works.\n2. It is tidy.",
  workerId: "worker-7", implId: "worker-3", lineId: "line-42", repoName: "web",
};
const cases = {
  "no remote": { ...base },
  "remote": { ...base, repoUrl: "https://github.com/o/web.git" },
  "remote and tracker ticket": { ...base, repoUrl: "https://github.com/o/web.git", trackerTicket: "ABC-12" },
  "no repo name": { ...base, repoName: "" },
  "no implementor id": { ...base, implId: "", repoUrl: "https://github.com/o/web.git" },
};

for (const persona of ["backend", "frontend"]) {
  for (const [label, a] of Object.entries(cases)) {
    test(`${persona} validator prompt equals validatorBrief(): ${label}`, () => {
      const old = validatorBrief(a.implName, a.report, a.criteria, persona, a.workerId, a.implId, a.lineId,
        a.repoName, a.repoUrl, a.trackerTicket);
      assert.equal(newBrief(persona, a), old);
    });
  }
}

test("validator header and fields", () => {
  const v = resolved.validator;
  assert.equal(v.session, "fresh");
  assert.equal(v.workspace, "source");
  assert.equal(v.outcome, "verdict");
  assert.equal(v.coordinator, false);
  assert.equal(v.fields.criteria.type, "text");
  assert.equal(v.fields.trackerTicket.optional, true);
  assert.deepEqual(Object.keys(v.fields).sort(), ["criteria", "trackerTicket"]);
});

test("persona types extend validator and add no fields", () => {
  for (const name of ["backend-validator", "frontend-validator"]) {
    assert.equal(resolved[name].extends, "validator");
    assert.deepEqual(resolved[name].chain, ["validator", name]);
    assert.equal(resolved[name].workspace, "source");
    assert.deepEqual(Object.keys(resolved[name].fields).sort(), ["criteria", "trackerTicket"]);
  }
});

test("the only caller placeholders are criteria and trackerTicket", () => {
  const { isRouterVariable } = require("../fields");
  for (const name of ["backend-validator", "frontend-validator"]) {
    const { vars } = placeholders(resolved[name].body);
    const caller = [...vars].filter((v) => !isRouterVariable(v)).sort();
    assert.deepEqual(caller, ["criteria", "trackerTicket"]);
    assert.ok(vars.has("source.report") && vars.has("source.name"));
  }
});

test("a call with criteria only passes the field check", () => {
  const r = checkValues(
    Object.fromEntries(Object.entries(resolved["backend-validator"].fields).map(([k, decl]) => [k, { decl, requiredBy: "validator" }])),
    { criteria: "1. x" });
  assert.deepEqual(r, { missing: [], invalid: [], unexpected: [] });
});
