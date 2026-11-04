"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadNodeType, resolveTypes } = require("../node-types");
const { render, placeholders } = require("../template");
const { checkValues } = require("../fields");

const { golden, slug } = require("./fixtures/golden-file");

const root = path.join(__dirname, "..");
const PORT = 7788;
const CHANGESET_LIMIT = 500;

const types = {};
for (const name of ["validator", "backend-validator", "frontend-validator"]) {
  types[name] = loadNodeType(path.join(root, "node-types", name), (f) => fs.readFileSync(f, "utf8"));
}
const resolved = resolveTypes(types);

function newBrief(persona, a) {
  const values = {
    line: { id: a.lineId, changesetLimit: String(CHANGESET_LIMIT) },
    instance: { id: a.workerId },
    source: { name: a.implName, id: a.implId, report: a.report },
    router: { url: `http://localhost:${PORT}` },
    repo: {},
    criteria: a.criteria,
  };
  if (a.repoName) values.repo.name = a.repoName;
  if (a.repoUrl) values.repo.url = a.repoUrl;
  if (a.trackerTicket) values.trackerTicket = a.trackerTicket;
  if (a.changesetWarning) values.source.changesetWarning = a.changesetWarning;
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
    // The golden files hold the output of the removed validatorBrief() for the same inputs
    // (one-off script run before D9 removed the function).
    test(`${persona} validator prompt equals the golden text of the old validatorBrief: ${label}`, () => {
      assert.equal(newBrief(persona, a), golden(`validator-${persona}-${slug(label)}`));
    });
  }
}

test("an oversize warning reaches the validator prompt next to the full report", () => {
  const warning = "The change set of the implementor is over the review-size target: "
    + "total 501 > target 500. Base commit abc123, head commit def456. "
    + "Per file: src/a.js: +499/-0; test/a.test.js: +2/-0. "
    + "Judge reviewability, not the count alone.";
  for (const persona of ["backend", "frontend"]) {
    const text = newBrief(persona, { ...base, repoUrl: "https://github.com/o/web.git",
      changesetWarning: warning });
    assert.ok(text.includes("Size warning from the router:"));
    assert.ok(text.includes("total 501 > target 500"));
    assert.ok(text.includes("Base commit abc123, head commit def456"));
    assert.ok(text.includes("Per file: src/a.js: +499/-0; test/a.test.js: +2/-0"));
    // The warning accompanies the report; it never replaces it.
    assert.ok(text.includes("The implementor reported:\nDone.\nTests pass."));
  }
});

test("without an oversize warning the prompt carries no warning text", () => {
  for (const persona of ["backend", "frontend"]) {
    const text = newBrief(persona, { ...base });
    assert.ok(!text.includes("Size warning from the router"));
    assert.ok(!text.includes("total 501"));
  }
});

test("the rendered prompt carries the reviewability instructions", () => {
  for (const persona of ["backend", "frontend"]) {
    const text = newBrief(persona, { ...base });
    assert.ok(text.includes("## Reviewability check"));
    assert.ok(text.includes("The review-size target is 500 changed lines."));
    assert.ok(text.includes("Judge readability, cohesion, and retained test coverage"));
  }
});

test("a clean 501-line change gets review, an unreadable 499-line change can fail", () => {
  for (const persona of ["backend", "frontend"]) {
    const text = newBrief(persona, { ...base });
    assert.ok(text.includes("Do not fail a readable, cohesive change only because its"),
      "a clean 501-line change is reviewed, not rejected for the count");
    assert.ok(text.includes("Fail the review when the change is unreadable"),
      "an unreadable 499-line change can fail review");
    assert.ok(text.includes("even below"));
  }
});

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
