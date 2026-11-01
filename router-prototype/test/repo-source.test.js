"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { cloneSourceError } = require("../repo-source");

test("accepts remote URLs", () => {
  for (const url of ["https://github.com/o/r.git", "ssh://git@host/o/r.git", "git@github.com:o/r.git"]) {
    assert.equal(cloneSourceError(url), null, url);
  }
});

test("refuses options, local paths, and other schemes by default", () => {
  for (const url of ["--upload-pack=touch /tmp/x", "/home/u/repo", "file:///home/u/repo", "http://host/r.git", "ext::sh -c x"]) {
    assert.notEqual(cloneSourceError(url), null, url);
  }
});

test("accepts local paths only with the opt-in, and never an option", () => {
  assert.equal(cloneSourceError("/home/u/repo", { allowLocal: true }), null);
  assert.notEqual(cloneSourceError("-u x", { allowLocal: true }), null);
});
