"use strict";

// Golden files guard harness behavior during the plugin refactor. Never
// regenerate them in a refactor task.
//
// The test computes the values again with the functions of
// scripts/record-harness-golden.js and compares them with
// test/fixtures/golden/harness-*.json. The HTTP golden may only grow by the
// additive plugin keys listed below.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { computeArgv, computeStream, computeApi } = require("../scripts/record-harness-golden");

const GOLDEN_DIR = path.join(__dirname, "fixtures", "golden");
const ENTRY_EXTRA_KEYS = ["displayName", "capabilities", "plugin"];
const TOP_EXTRA_KEYS = ["pluginProblems"];

const readGolden = (name) => JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, name), "utf8"));

// Every golden key must match exactly. A key that is not in the golden may
// only come from the allowed list.
function assertSubsetWithAllowedExtras(actual, golden, allowedExtra, label) {
  for (const key of Object.keys(golden)) {
    assert.deepStrictEqual(actual[key], golden[key], `${label}.${key}`);
  }
  for (const key of Object.keys(actual)) {
    if (key in golden) continue;
    assert.ok(allowedExtra.includes(key), `${label}: unexpected extra key '${key}'`);
  }
}

test("argv, env, cwd and spawn-plan decisions match the golden", () => {
  assert.deepStrictEqual(computeArgv(), readGolden("harness-argv.json"));
});

test("stream parsing, session ids, tokens and outcomes match the golden", () => {
  assert.deepStrictEqual(computeStream(), readGolden("harness-stream.json"));
});

test("HTTP harness metadata matches the golden; only plugin keys may be added", { timeout: 60_000 }, async () => {
  const actual = await computeApi();
  const golden = readGolden("harness-api.json");

  assert.strictEqual(actual.list.status, golden.list.status);
  // The entries are compared one by one below, where additive keys are allowed.
  const { harnesses: goldenEntries, ...goldenTop } = golden.list.body;
  const { harnesses: actualEntries, ...actualTop } = actual.list.body;
  assertSubsetWithAllowedExtras(actualTop, goldenTop, TOP_EXTRA_KEYS, "list.body");
  assert.strictEqual(actual.list.body.harnesses.length, golden.list.body.harnesses.length);
  golden.list.body.harnesses.forEach((goldenEntry, i) => {
    assertSubsetWithAllowedExtras(
      actual.list.body.harnesses[i], goldenEntry, ENTRY_EXTRA_KEYS, `harness ${goldenEntry.id}`);
  });

  for (const name of ["piDetail", "piMissingProvider", "piUnknownProvider"]) {
    assert.deepStrictEqual(actual[name], golden[name], name);
  }
});

test("the extra-key check rejects keys outside the additive list", () => {
  assert.throws(() => assertSubsetWithAllowedExtras({ a: 1, b: 2 }, { a: 1 }, ["c"], "x"), /unexpected extra key 'b'/);
  assert.doesNotThrow(() => assertSubsetWithAllowedExtras({ a: 1, c: 2 }, { a: 1 }, ["c"], "x"));
});
