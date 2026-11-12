"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startScriptRun, formatReport } = require("../script-runner");
const { explicitVerdict, collectAssistantText } = require("../handoff");

function sandbox(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "script-runner-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const runRoot = path.join(base, "root");
  fs.mkdirSync(runRoot);
  return { base, runRoot, logDir: path.join(base, "logs") };
}

function step(name, run, extra = {}) {
  return { name, run, timeout: 20, ...extra };
}

async function run(box, steps, extra = {}) {
  const entries = [];
  const stepCalls = [];
  const dones = [];
  const handle = startScriptRun({
    nodeId: "ci", steps, failFast: true, runRoot: box.runRoot, checkout: "clean",
    checkClean: false, repoName: "cuck-code", branch: "b", commit: "c",
    env: { PATH: process.env.PATH }, timeLimitSec: 30, logDir: box.logDir,
    killGraceMs: 200,
    hooks: {
      onEntry: (e) => entries.push(e),
      onStep: (r) => stepCalls.push(r),
      onDone: (r) => dones.push(r),
    },
    ...extra,
  });
  if (extra.afterStart) extra.afterStart(handle);
  const result = await handle.done;
  const report = collectAssistantText(entries);
  return { handle, result, entries, stepCalls, dones, report };
}

const statuses = (out) => out.stepCalls[out.stepCalls.length - 1].map((r) => r.status);

test("all scripts pass", async (t) => {
  const box = sandbox(t);
  const out = await run(box, [step("a", "exit 0"), step("b", "echo hi")]);
  assert.deepEqual(statuses(out), ["pass", "pass"]);
  assert.equal(out.handle.child, null);
  assert.equal(out.dones.length, 1);
  assert.deepEqual(out.result, {
    outcome: "ok", exitCode: 0, signal: null, command: "script-check", spawnError: null, stderr: null,
  });
  assert.equal(explicitVerdict(out.report), "pass");
  assert.match(out.report, /^CHECK REPORT - node 'ci' ran 2 scripts in /);
  assert.match(out.report, /1\. a: PASS \(exit 0, \d+\.\d s\)/);
  assert.match(out.entries[0].text, /^Run 1\. a in .+: exit 0$/);
  assert.equal(fs.readFileSync(path.join(box.logDir, "2-b.log"), "utf8"), "hi\n");
});

test("failure with failFast true skips the rest, false runs them", async (t) => {
  const box = sandbox(t);
  const steps = [step("a", "echo boom; exit 3"), step("b", "exit 0")];
  const fast = await run(box, steps);
  assert.deepEqual(statuses(fast), ["fail", "skipped"]);
  assert.match(fast.report, /2\. b: SKIPPED \(an earlier script failed\)/);
  assert.match(fast.report, /1\. a: FAIL \(exit 3, /);
  assert.match(fast.report, /   Command: echo boom; exit 3/);
  assert.match(fast.report, /   Log: .*1-a\.log/);
  assert.match(fast.report, /   Last output lines:\n   \| boom\n/);
  assert.equal(explicitVerdict(fast.report), "fail");
  assert.equal(fast.result.outcome, "ok");
  const slow = await run(box, steps, { failFast: false });
  assert.deepEqual(statuses(slow), ["fail", "pass"]);
  assert.equal(explicitVerdict(slow.report), "fail");
});

test("repo filter and no applicable script", async (t) => {
  const box = sandbox(t);
  const mixed = await run(box, [step("a", "exit 0"), step("py", "exit 1", { repos: ["other"] })]);
  assert.match(mixed.report, /2\. py: SKIPPED \(not for repo 'cuck-code'\)/);
  assert.equal(explicitVerdict(mixed.report), "pass");
  const none = await run(box, [step("py", "exit 0", { repos: ["other"] })]);
  assert.match(none.report, /No script applies to repo 'cuck-code'\./);
  assert.equal(explicitVerdict(none.report), "fail");
});

test("cwd subfolder is the process cwd", async (t) => {
  const box = sandbox(t);
  fs.mkdirSync(path.join(box.runRoot, "sub"));
  const out = await run(box, [step("pwd", "pwd; exit 1", { cwd: "sub" })]);
  assert.match(out.report, new RegExp(`\\| ${path.join(box.runRoot, "sub")}\\n`));
});

test("missing cwd and cwd symlink outside the run root fail without spawning", async (t) => {
  const box = sandbox(t);
  fs.mkdirSync(path.join(box.base, "outside"));
  fs.symlinkSync(path.join(box.base, "outside"), path.join(box.runRoot, "link"));
  let spawned = 0;
  const spawnImpl = () => { spawned += 1; throw new Error("no spawn"); };
  const out = await run(
    box,
    [step("a", "exit 0", { cwd: "nope" }), step("b", "exit 0", { cwd: "link" })],
    { spawnImpl, failFast: false },
  );
  assert.equal(spawned, 0);
  assert.deepEqual(statuses(out), ["fail", "fail"]);
  assert.match(out.report, /cwd 'nope' is missing or outside the run root/);
  assert.match(out.report, /cwd 'link' is missing or outside the run root/);
});

function gitRepo(box) {
  const git = (...args) => execFileSync("git", ["-C", box.runRoot, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(box.runRoot, "tracked.txt"), "one\n");
  fs.writeFileSync(path.join(box.runRoot, ".gitignore"), "ignored.txt\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
}

test("worktree-clean check", async (t) => {
  const box = sandbox(t);
  gitRepo(box);
  const opts = { checkClean: true, checkout: "worktree" };
  const tracked = await run(box, [step("a", "echo two > tracked.txt")], opts);
  assert.match(tracked.report, /worktree-clean: FAIL \(scripts changed: tracked\.txt\)/);
  assert.equal(explicitVerdict(tracked.report), "fail");
  execFileSync("git", ["-C", box.runRoot, "checkout", "--", "tracked.txt"]);
  const added = await run(box, [step("a", "echo x > new.txt")], opts);
  assert.match(added.report, /worktree-clean: FAIL \(scripts changed: new\.txt\)/);
  fs.rmSync(path.join(box.runRoot, "new.txt"));
  const ignored = await run(box, [step("a", "echo x > ignored.txt")], opts);
  assert.doesNotMatch(ignored.report, /worktree-clean/);
  assert.equal(explicitVerdict(ignored.report), "pass");
  const off = await run(box, [step("a", "echo x > new.txt")], { checkClean: false });
  assert.doesNotMatch(off.report, /worktree-clean/);
});

test("step timeout kills the process group", async (t) => {
  const box = sandbox(t);
  const out = await run(box, [step("slow", "echo x; sleep 5", { timeout: 1 })]);
  assert.match(out.report, /1\. slow: FAIL \(timed out after 1 s, /);
  assert.equal(statuses(out)[0], "fail");
  assert.ok(out.stepCalls[0][0].durationMs < 4000);
});

test("whole-run limit skips the rest and reports outcome timeout", async (t) => {
  const box = sandbox(t);
  const out = await run(box, [step("slow", "sleep 5"), step("b", "exit 0")], {
    timeLimitSec: 0.3, failFast: false,
  });
  assert.equal(out.result.outcome, "timeout");
  assert.match(out.report, /1\. slow: FAIL \(run time limit reached/);
  assert.match(out.report, /2\. b: SKIPPED \(run time limit reached\)/);
  assert.equal(explicitVerdict(out.report), "fail");
  assert.equal(out.dones.length, 1);
});

test("kill stops the run and finishes with fail and the signal", async (t) => {
  const box = sandbox(t);
  let killed = null;
  const out = await run(box, [step("slow", "sleep 5"), step("b", "exit 0")], {
    failFast: false,
    afterStart: (handle) => setTimeout(() => { killed = handle.kill("SIGINT"); }, 200),
  });
  assert.equal(killed, true);
  assert.equal(out.result.outcome, "fail");
  assert.equal(out.result.signal, "SIGINT");
  assert.match(out.report, /2\. b: SKIPPED \(run stopped\)/);
  assert.equal(explicitVerdict(out.report), "fail");
});

test("log truncation and output tail", async (t) => {
  const box = sandbox(t);
  const out = await run(box, [
    step("big", "i=0; while [ $i -lt 100 ]; do echo line-$i; i=$((i+1)); done; exit 1"),
  ], { maxLogBytes: 50 });
  const log = fs.readFileSync(path.join(box.logDir, "1-big.log"), "utf8");
  assert.ok(log.startsWith("line-0\n"));
  assert.ok(log.trimEnd().endsWith("[log truncated at 10 MB]"));
  assert.ok(!log.includes("line-99"));
  const tail = out.report.split("\n").filter((l) => l.startsWith("   | "));
  assert.equal(tail.length, 60);
  assert.equal(tail[59], "   | line-99");
  assert.equal(tail[0], "   | line-40");
});

test("formatReport lists the result lines in the documented format", () => {
  const meta = { nodeId: "ci", runRoot: "/r", checkout: "worktree", branch: "b", commit: "c", repoName: "x" };
  const report = formatReport([
    { index: 1, name: "format", status: "pass", exitCode: 0, durationMs: 3200 },
    { index: 2, name: "unit", status: "fail", exitCode: 1, durationMs: 41000,
      command: "npm t", logFile: "/l/2-unit.log", tail: ["a", "b"] },
    { index: 3, name: "py-lint", status: "skipped", reason: "not for repo 'x'" },
    { name: "worktree-clean", status: "fail", reason: "scripts changed: a.txt, b/c.js" },
  ], meta);
  assert.equal(report, [
    "CHECK REPORT - node 'ci' ran 2 scripts in '/r' (checkout worktree, branch b, commit c).",
    "1. format: PASS (exit 0, 3.2 s)",
    "2. unit: FAIL (exit 1, 41.0 s)",
    "   Command: npm t",
    "   Log: /l/2-unit.log",
    "   Last output lines:",
    "   | a",
    "   | b",
    "3. py-lint: SKIPPED (not for repo 'x')",
    "worktree-clean: FAIL (scripts changed: a.txt, b/c.js)",
    "VERDICT: FAIL",
  ].join("\n"));
});
