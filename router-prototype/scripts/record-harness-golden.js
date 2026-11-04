#!/usr/bin/env node
"use strict";

// Records the harness golden files from the CURRENT code:
//   test/fixtures/golden/harness-argv.json
//   test/fixtures/golden/harness-stream.json
//   test/fixtures/golden/harness-api.json
// The golden files guard harness behavior during the plugin refactor. Run
// this script once, on the code before the refactor. Never regenerate the
// files in a refactor task. test/harness-characterization.test.js requires
// this module and computes the same values with the compute* functions.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const FIXTURES = path.join(ROOT, "test", "fixtures");
const GOLDEN_DIR = path.join(FIXTURES, "golden");
const { createHarness, trustedSystemChannel } = require(path.join(ROOT, "harness"));
const spawnPlan = require(path.join(ROOT, "spawn-plan"));
const { startRouter, stopRouter } = require(path.join(FIXTURES, "router-process"));
const { writeFakeClis } = require(path.join(FIXTURES, "fake-harness-clis"));

const IDS = ["vibe", "pi", "codex", "claude"];
const STREAMS = [
  { fixture: "claude", id: "claude" },
  { fixture: "codex", id: "codex" },
  { fixture: "pi", id: "pi" },
  { fixture: "pi-handoff", id: "pi" },
  { fixture: "vibe", id: "vibe" },
];
const EXITS = [[0, null], [1, null], [3, null], [null, "SIGTERM"], [null, "SIGKILL"]];

// The base ctx of test/harness.test.js.
const CTX = {
  phase: "work",
  prompt: "Do the task",
  workdir: "/tmp/work",
  sessionId: null,
  model: "model-x",
  effort: "medium",
  timeLimitSec: 120,
  autoApprove: false,
};

const SYSTEM_PROMPT_FILE_PLACEHOLDER = "<SYSTEM_PROMPT_FILE>";

// Replaces temp paths in any JSON value. The system prompt file goes first:
// it lives inside the temp dir.
function scrub(value, { tmpDir, promptFile }) {
  let text = JSON.stringify(value);
  if (promptFile) text = text.split(JSON.stringify(promptFile).slice(1, -1)).join(SYSTEM_PROMPT_FILE_PLACEHOLDER);
  text = text.split(JSON.stringify(tmpDir).slice(1, -1)).join("<TMP>");
  return JSON.parse(text);
}

function makeTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-golden-")));
}

function recordBuild(id, ctx) {
  try {
    const run = createHarness(id).buildRun(ctx);
    return { cmd: run.cmd, args: run.args, env: run.env, cwd: run.cwd === undefined ? null : run.cwd };
  } catch (err) {
    return { error: err.message };
  }
}

function argvMatrix(promptFile) {
  return {
    "new session": {},
    "resume": { sessionId: "s-1" },
    "model m-1": { model: "m-1" },
    "model null": { model: null },
    "effort low": { effort: "low" },
    "effort high": { effort: "high" },
    "effort max": { effort: "max" },
    "autoApprove true": { autoApprove: true },
    "autoApprove false": { autoApprove: false },
    "system prompt none": {},
    "system prompt inline": { systemPrompt: "Be the role." },
    "system prompt file": { systemPromptFile: promptFile },
    "dash prompt": { prompt: "--- PLANNER TURN CONTEXT ---\nDo the task" },
  };
}

function computeArgv() {
  const tmpDir = makeTmp();
  try {
    const promptFile = path.join(tmpDir, "system-prompt.txt");
    fs.writeFileSync(promptFile, "Be the role from a file.", "utf8");
    const out = {};
    for (const id of IDS) {
      const builds = {};
      for (const [name, patch] of Object.entries(argvMatrix(promptFile))) {
        builds[name] = recordBuild(id, { ...CTX, ...patch });
      }
      out[id] = {
        builds,
        trustedSystemChannel: trustedSystemChannel(id),
        supportsNativeTimeLimit: createHarness(id).supportsNativeTimeLimit,
        usesSystemChannelRole: spawnPlan.usesSystemChannel(id, "role"),
        systemPromptOptionsLong: spawnPlan.systemPromptOptions(id, "x".repeat(1200), tmpDir),
        systemPromptOptionsShort: spawnPlan.systemPromptOptions(id, "short", tmpDir),
        brief: spawnPlan.briefForHarness(id, { prompt: "P", rolePrompt: "R", taskPrompt: "T" }),
      };
    }
    return scrub(out, { tmpDir, promptFile });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function readRecords(name) {
  return fs.readFileSync(path.join(FIXTURES, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function computeStream() {
  const out = {};
  for (const { fixture, id } of STREAMS) {
    const harness = createHarness(id);
    const entries = [];
    const collect = (entry) => {
      if (!entry) return;
      const { at, ...rest } = entry; // `at` is a clock value
      entries.push(rest);
    };
    for (const record of readRecords(fixture)) collect(harness.normalize(record));
    collect(harness.finalize());
    const outcomes = {};
    for (const [code, signal] of EXITS) outcomes[`${code},${signal}`] = harness.outcome(code, signal);
    out[fixture] = {
      harness: id,
      entries,
      sessionId: harness.sessionId,
      contextTokens: harness.contextTokens,
      errorText: harness.errorText(),
      outcomes,
    };
  }
  return out;
}

async function getJson(base, pathname) {
  const res = await fetch(base + pathname);
  return { status: res.status, body: await res.json() };
}

async function computeApi() {
  const tmpDir = makeTmp();
  const binDir = path.join(tmpDir, "bin");
  fs.mkdirSync(binDir);
  writeFakeClis(binDir, tmpDir);
  // A minimal PATH keeps host CLIs (a real claude or codex) out of the golden file.
  const router = await startRouter(path.join(tmpDir, "lines"), {
    PATH: `${binDir}:/usr/bin:/bin`,
    CLAUDE_CONFIG_DIR: path.join(tmpDir, "claude-config"),
  });
  try {
    const list = await getJson(router.base, "/api/harnesses");
    delete list.body.probedAt; // a clock value
    return scrub({
      list,
      piDetail: await getJson(router.base, "/api/harnesses/pi?provider=anthropic"),
      piMissingProvider: await getJson(router.base, "/api/harnesses/pi"),
      piUnknownProvider: await getJson(router.base, "/api/harnesses/pi?provider=gemini"),
    }, { tmpDir });
  } finally {
    await stopRouter(router);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const files = {
    "harness-argv.json": computeArgv(),
    "harness-stream.json": computeStream(),
    "harness-api.json": await computeApi(),
  };
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(GOLDEN_DIR, name), JSON.stringify(value, null, 2) + "\n");
    console.log(`wrote ${name}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { computeArgv, computeStream, computeApi };
