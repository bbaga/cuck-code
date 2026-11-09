"use strict";

const good = require("../good");

module.exports = function createHarnessPlugin(sdk) {
  return { ...good(sdk), id: "other-name" };
};
