"use strict";
// Isolation regression for the settings round-trip fixture browser test.
// The test file runs in a child process from an empty temporary cwd, with
// LINES_DIR unset and with LINES_DIR set to a sentinel state directory.
// Neither run may write the default ./lines directory or touch the sentinel.
// This file never runs itself: it runs the fixture test file only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TARGET = path.join(__dirname, "settings-roundtrip-fixture-browser.test.js");
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Run the fixture test file with node's TAP reporter and return its counts.
function runChild(cwd, linesDir) {
  // Drop the parent runner marker so the child prints its own TAP report.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  if (linesDir === null) delete env.LINES_DIR;
  else env.LINES_DIR = linesDir;
  const r = spawnSync(process.execPath,
    ["--test", "--test-reporter=tap", "--test-force-exit", TARGET],
    { cwd, env, encoding: "utf8", timeout: 180000 });
  const count = (name) => Number((new RegExp(`^# ${name} (\\d+)`, "m").exec(r.stdout) || [])[1]);
  return { status: r.status, out: r.stdout, err: r.stderr, signal: r.signal, spawnError: r.error, tests: count("tests"), pass: count("pass"),
    fail: count("fail"), skipped: count("skipped") };
}

// Every entry under dir: relative path -> file bytes (or null for a directory).
function snapshot(dir) {
  const result = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const rel = path.relative(dir, p);
      if (fs.statSync(p).isDirectory()) { result[rel] = null; walk(p); }
      else result[rel] = fs.readFileSync(p).toString("base64");
    }
  };
  walk(dir);
  return result;
}

const assertExercised = (child, label) => {
  const detail = `${label}: signal=${child.signal} spawnError=${child.spawnError}\n`
    + `stdout tail:\n${child.out.slice(-1500)}\nstderr tail:\n${(child.err || "").slice(-1500)}`;
  assert.equal(child.status, 0, `the child exits with code 0, ${detail}`);
  assert.equal(child.fail, 0, `no child test fails, ${detail}`);
  assert.equal(child.skipped, 0, `no child test is skipped, so the headless browser ran, ${detail}`);
  assert.ok(child.tests >= 5 && child.pass === child.tests, `all child tests pass, ${detail}`);
};

test("the fixture browser test leaves an empty cwd untouched", () => {
  const cwd = tmp("roundtrip-isolation-cwd-");
  try {
    const child = runChild(cwd, null);
    assertExercised(child, "LINES_DIR unset");
    assert.deepEqual(fs.readdirSync(cwd), [],
      "no lines directory and no work-coordination file appear in the cwd");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("the fixture browser test neither loads nor modifies a sentinel state directory", () => {
  const cwd = tmp("roundtrip-isolation-cwd-");
  const sentinel = tmp("roundtrip-sentinel-");
  try {
    // Recognizable fixtures: a work registry and a line repo. A server that
    // loads this directory would rewrite the registry or add entries.
    fs.writeFileSync(path.join(sentinel, "work-coordination.json"),
      JSON.stringify({ sentinel: "do-not-touch", items: [] }));
    fs.mkdirSync(path.join(sentinel, "sentinel-line", "repos"), { recursive: true });
    fs.writeFileSync(path.join(sentinel, "sentinel-line", "repos", "NOTE.txt"), "sentinel bytes\n");
    const before = snapshot(sentinel);

    const child = runChild(cwd, sentinel);
    assertExercised(child, "LINES_DIR set to the sentinel");
    assert.deepEqual(snapshot(sentinel), before, "the sentinel files and bytes are unchanged");
    assert.deepEqual(fs.readdirSync(cwd), [], "the cwd stays empty");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(sentinel, { recursive: true, force: true });
  }
});
