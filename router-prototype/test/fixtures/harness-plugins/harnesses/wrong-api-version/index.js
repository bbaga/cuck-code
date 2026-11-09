"use strict";

const good = require("../good");

module.exports = function createHarnessPlugin(sdk) {
  return { ...good(sdk), id: "wrong-api-version", apiVersion: 2 };
};
