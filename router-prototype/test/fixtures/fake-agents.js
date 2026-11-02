"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Fake agent CLIs for tests that need the router to find the harnesses (the harness gate and
// the planner start at boot). The probe calls (--version, --help, auth/login status, model list)
// answer at once; any other call sleeps like a running agent. Never depend on the real CLIs: a CI
// runner has none of them.
const AGENTS = ["vibe", "pi", "codex", "claude"];

function installFakeAgents(dir) {
  const bin = path.join(dir, "fake-agent-bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const agent of AGENTS) {
    const file = path.join(bin, agent);
    fs.writeFileSync(file, '#!/bin/sh\ncase "$1" in --version|--help|-h|login|auth|--list-models) echo "fake 1.0"; exit 0;; esac\nsleep 60\n');
    fs.chmodSync(file, 0o755);
  }
  return bin;
}

module.exports = { installFakeAgents, AGENTS };
