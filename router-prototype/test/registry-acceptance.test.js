"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { choosePort } = require("../scripts/registry-acceptance");

test("acceptance helper selects an ephemeral port other than 7788", async () => {
  const port = await choosePort();
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  assert.notEqual(port, 7788);
});
