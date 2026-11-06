"use strict";

const good = require("../good");

module.exports = function createHarnessPlugin(sdk) {
  const { resumeSession, ...rest } = good(sdk);
  return { ...rest, id: "no-resume" };
};
