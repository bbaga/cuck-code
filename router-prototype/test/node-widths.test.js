"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { nodeWidth, columnWidth } = require("../web/pipeline-ui.js");

const measure = (text) => text.length * 7;
const base = { name: "alpha", persona: "backend", status: "idle", harness: "claude", model: "opus", effort: "high" };

test("a longer name gives a wider node", () => {
  assert.ok(nodeWidth({ ...base, name: "alpha-longer-name" }, measure) > nodeWidth(base, measure));
});

test("a very long name is never cut", () => {
  const name = "x".repeat(300);
  assert.ok(nodeWidth({ ...base, name }, measure) >= measure(name));
});

test("a running worker adds the Stop button width", () => {
  const diff = nodeWidth({ ...base, status: "running" }, measure) - nodeWidth(base, measure);
  assert.ok(diff >= measure("Stop"));
});

test("config text adds width", () => {
  const bare = { name: "alpha", persona: "backend", status: "idle" };
  assert.ok(nodeWidth(base, measure) > nodeWidth(bare, measure));
});

test("columnWidth returns the maximum and respects the minimum", () => {
  assert.equal(columnWidth([150, 300, 200]), 300);
  assert.equal(columnWidth([10, 20]), 120);
  assert.equal(columnWidth([]), 120);
});
