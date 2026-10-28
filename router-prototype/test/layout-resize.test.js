"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { clampSize, readStoredSize, writeStoredSize } = require("../web/pipeline-ui.js");

const memory = (init = {}) => {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
};

test("clampSize keeps values inside the range", () => {
  assert.equal(clampSize(50, 80, 400), 80);
  assert.equal(clampSize(500, 80, 400), 400);
  assert.equal(clampSize(200, 80, 400), 200);
  assert.equal(clampSize(NaN, 80, 400), 80);
  assert.equal(clampSize(300, 120, 50), 120);
});

test("readStoredSize clamps saved values to the window", () => {
  const s = memory({ k: "900" });
  assert.equal(readStoredSize(s, "k", 80, 400), 400);
  assert.equal(readStoredSize(memory({ k: "10" }), "k", 80, 400), 80);
});

test("readStoredSize ignores bad or missing values", () => {
  for (const v of ["abc", "", "-5", "0", "Infinity"]) {
    assert.equal(readStoredSize(memory({ k: v }), "k", 80, 400), null, v);
  }
  assert.equal(readStoredSize(memory(), "k", 80, 400), null);
});

test("readStoredSize and writeStoredSize accept missing or broken storage", () => {
  assert.equal(readStoredSize(null, "k", 80, 400), null);
  assert.equal(writeStoredSize(undefined, "k", 100), false);
  const broken = { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); } };
  assert.equal(readStoredSize(broken, "k", 80, 400), null);
  assert.equal(writeStoredSize(broken, "k", 100), false);
});

test("writeStoredSize saves a rounded size and null resets it", () => {
  const s = memory();
  assert.equal(writeStoredSize(s, "k", 150.6), true);
  assert.equal(readStoredSize(s, "k", 80, 400), 151);
  writeStoredSize(s, "k", null);
  assert.equal(readStoredSize(s, "k", 80, 400), null);
});
