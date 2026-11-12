"use strict";

// Runs the scripts of one script check node. It is a pure module: the caller
// creates the run root, supplies the environment and receives the progress
// through hooks. The handle has the same shape as the one of startRun in
// harness-runner.js: { kill, done, child }.

const childProcess = require("node:child_process");
const nodeFs = require("node:fs");
const path = require("node:path");

const TAIL_LINES = 60;
const TAIL_CHARS = 8000;
const MAX_REPORTED_PATHS = 20;

function defaultGitStatus(dir) {
  return childProcess.execFileSync(
    "git",
    ["-C", dir, "status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" },
  );
}

function seconds(ms) {
  return (ms / 1000).toFixed(1);
}

// A script skipped by the repo filter does not count as a failure.
function isFilterSkip(result) {
  return result.status === "skipped" && result.skipKind === "repo";
}

function describeResult(result) {
  if (result.status === "pass") return `PASS (exit 0, ${seconds(result.durationMs)} s)`;
  if (result.status === "skipped") return `SKIPPED (${result.reason})`;
  let detail = result.reason;
  if (!detail && result.signal) detail = `signal ${result.signal}`;
  if (!detail && result.exitCode !== null && result.exitCode !== undefined) {
    detail = `exit ${result.exitCode}`;
  }
  if (!detail) detail = "no reason";
  return result.durationMs === undefined
    ? `FAIL (${detail})`
    : `FAIL (${detail}, ${seconds(result.durationMs)} s)`;
}

function verdictOf(results) {
  const scripts = results.filter((r) => r.index !== undefined);
  const clean = results.every((r) => r.status === "pass" || isFilterSkip(r));
  return clean && scripts.some((r) => r.status === "pass") ? "PASS" : "FAIL";
}

// results: the script results in order, then optionally worktree-clean.
// Each result may carry `command` and `tail` (an array of lines) for the report.
function formatReport(results, meta) {
  const scripts = results.filter((r) => r.index !== undefined);
  const ran = scripts.filter((r) => r.status !== "skipped").length;
  const lines = [
    `CHECK REPORT - node '${meta.nodeId}' ran ${ran} scripts in '${meta.runRoot}' ` +
      `(checkout ${meta.checkout}, branch ${meta.branch}, commit ${meta.commit}).`,
  ];
  for (const r of results) {
    const label = r.index === undefined ? `${r.name}:` : `${r.index}. ${r.name}:`;
    lines.push(`${label} ${describeResult(r)}`);
    if (r.index === undefined || r.status !== "fail") continue;
    if (r.command) lines.push(`   Command: ${r.command}`);
    if (r.logFile) lines.push(`   Log: ${r.logFile}`);
    if (r.tail && r.tail.length) {
      lines.push("   Last output lines:");
      for (const line of r.tail) lines.push(`   | ${line}`);
    }
  }
  if (scripts.length > 0 && scripts.every(isFilterSkip)) {
    lines.push(`No script applies to repo '${meta.repoName}'.`);
  }
  lines.push(`VERDICT: ${verdictOf(results)}`);
  return lines.join("\n");
}

function lastLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  let tail = lines.slice(-TAIL_LINES).join("\n");
  if (tail.length > TAIL_CHARS) tail = tail.slice(-TAIL_CHARS);
  return tail ? tail.split("\n") : [];
}

function changedPaths(before, after) {
  const toSet = (text) => new Set(String(text).split("\n").filter((l) => l.trim()));
  const a = toSet(before);
  const b = toSet(after);
  const paths = new Set();
  for (const line of [...a].filter((l) => !b.has(l)).concat([...b].filter((l) => !a.has(l)))) {
    paths.add(line.slice(3));
  }
  return [...paths].sort().slice(0, MAX_REPORTED_PATHS);
}

function startScriptRun(options) {
  const {
    nodeId, steps, failFast, runRoot, checkout, checkClean,
    repoName, branch, commit, env = {}, timeLimitSec, logDir, hooks = {},
    spawnImpl = childProcess.spawn,
    fsImpl = nodeFs,
    gitStatus = defaultGitStatus,
    now = Date.now,
    timers = {},
    maxLogBytes = 10485760,
    killGraceMs = 10000,
  } = options;
  const setTimer = timers.setTimeout || setTimeout;
  const clearTimer = timers.clearTimeout || clearTimeout;

  let stopSignal = null; // set by kill()
  let limitHit = false;
  let current = null; // { child, terminate }

  const stopReason = () => {
    if (stopSignal) return "run stopped";
    return limitHit ? "run time limit reached" : null;
  };

  // SIGTERM to the process group, SIGKILL after the grace time.
  function makeTerminator(child) {
    let killTimer = null;
    const send = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch (_err) {
        try { child.kill(signal); } catch (_err2) { /* already gone */ }
      }
    };
    const terminate = () => {
      if (killTimer) return;
      send("SIGTERM");
      killTimer = setTimer(() => send("SIGKILL"), killGraceMs);
    };
    terminate.cancel = () => { if (killTimer) clearTimer(killTimer); };
    return terminate;
  }

  // Runs one process. Resolves with the exit data, never rejects.
  function runProcess(step, dir, logFile) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl("/bin/sh", ["-c", step.run], {
          cwd: dir,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...env, ...step.env, CI: "true" },
        });
      } catch (err) {
        resolve({ spawnError: err, tail: [] });
        return;
      }

      let fd = null;
      try {
        fd = fsImpl.openSync(logFile, "w");
      } catch (_err) { /* the log is lost, the run goes on */ }
      let written = 0;
      let truncated = false;
      let tailText = "";
      const writeLog = (text) => {
        if (fd === null) return;
        try { fsImpl.writeSync(fd, text); } catch (_err) { fd = null; }
      };
      const onData = (chunk) => {
        const text = chunk.toString();
        tailText = (tailText + text).slice(-TAIL_CHARS * 2);
        if (truncated) return;
        const room = maxLogBytes - written;
        const bytes = Buffer.byteLength(text);
        if (bytes <= room) {
          written += bytes;
          writeLog(text);
          return;
        }
        truncated = true;
        writeLog(Buffer.from(text).subarray(0, Math.max(room, 0)).toString());
        writeLog("\n[log truncated at 10 MB]\n");
      };
      if (child.stdout) child.stdout.on("data", onData);
      if (child.stderr) child.stderr.on("data", onData);

      const terminate = makeTerminator(child);
      let timedOut = false;
      const stepTimer = setTimer(() => {
        timedOut = true;
        terminate();
      }, step.timeout * 1000);
      current = { child, terminate };

      let settled = false;
      const settle = (data) => {
        if (settled) return;
        settled = true;
        clearTimer(stepTimer);
        terminate.cancel();
        current = null;
        if (fd !== null) {
          try { fsImpl.closeSync(fd); } catch (_err) { /* ignore */ }
        }
        resolve({ ...data, timedOut, tail: lastLines(tailText) });
      };
      child.on("error", (err) => settle({ spawnError: err }));
      child.on("close", (code, signal) => settle({ exitCode: code, signal }));
    });
  }

  function resolveDir(step) {
    let root;
    try {
      root = fsImpl.realpathSync(runRoot);
      const dir = fsImpl.realpathSync(path.join(runRoot, step.cwd || ""));
      const inside = dir === root || dir.startsWith(root + path.sep);
      if (inside && fsImpl.statSync(dir).isDirectory()) return dir;
    } catch (_err) { /* missing */ }
    return null;
  }

  async function execute() {
    fsImpl.mkdirSync(logDir, { recursive: true });
    let before = null;
    let statusError = null;
    if (checkClean) {
      try { before = gitStatus(runRoot); } catch (err) { statusError = err; }
    }

    const results = [];
    let anyFailed = false;
    const emit = (text, role = "system") => {
      if (hooks.onEntry) hooks.onEntry({ type: "message", role, text, at: now() });
    };

    for (let n = 0; n < steps.length; n += 1) {
      const step = steps[n];
      const index = n + 1;
      const result = { index, name: step.name, status: "skipped", exitCode: null, signal: null,
        durationMs: 0, reason: null, logFile: null };
      let skip = null;
      if (step.repos && !step.repos.includes(repoName)) {
        skip = { kind: "repo", reason: `not for repo '${repoName}'` };
      } else if (stopSignal) {
        skip = { kind: "stopped", reason: "run stopped" };
      } else if (limitHit) {
        skip = { kind: "time-limit", reason: "run time limit reached" };
      } else if (anyFailed && failFast) {
        skip = { kind: "fail-fast", reason: "an earlier script failed" };
      }
      if (skip) {
        result.skipKind = skip.kind;
        result.reason = skip.reason;
        results.push(result);
        if (hooks.onStep) hooks.onStep(results.map((r) => ({ ...r })));
        continue;
      }

      const dir = resolveDir(step);
      if (!dir) {
        result.status = "fail";
        result.reason = `cwd '${step.cwd}' is missing or outside the run root`;
      } else {
        emit(`Run ${index}. ${step.name} in ${dir}: ${step.run}`);
        result.logFile = path.join(logDir, `${index}-${step.name}.log`);
        const started = now();
        const out = await runProcess(step, dir, result.logFile);
        result.durationMs = now() - started;
        result.exitCode = out.exitCode ?? null;
        result.signal = out.signal ?? null;
        result.tail = out.tail;
        result.command = step.run;
        if (out.spawnError) {
          result.status = "fail";
          result.reason = `spawn error: ${out.spawnError.message}`;
        } else if (stopReason()) {
          result.status = "fail";
          result.reason = stopReason();
        } else if (out.timedOut) {
          result.status = "fail";
          result.reason = `timed out after ${step.timeout} s`;
        } else {
          result.status = out.exitCode === 0 ? "pass" : "fail";
        }
      }
      if (result.status === "fail") anyFailed = true;
      emit(`${index}. ${step.name}: ${describeResult(result)}`);
      results.push(result);
      if (hooks.onStep) hooks.onStep(results.map((r) => ({ ...r })));
    }

    if (checkClean && !stopSignal) {
      let reason = null;
      try {
        if (statusError) throw statusError;
        const changed = changedPaths(before, gitStatus(runRoot));
        if (changed.length) reason = `scripts changed: ${changed.join(", ")}`;
      } catch (err) {
        reason = `could not read git status: ${err.message}`;
      }
      if (reason) results.push({ name: "worktree-clean", status: "fail", reason });
    }

    const report = formatReport(results, { nodeId, runRoot, checkout, branch, commit, repoName });
    emit(report, "assistant");
  }

  let limitTimer = null;
  let finished = false;
  const done = new Promise((resolve) => {
    const finish = (outcome, signal, spawnError) => {
      if (finished) return;
      finished = true;
      if (limitTimer) clearTimer(limitTimer);
      const result = {
        outcome, exitCode: outcome === "ok" ? 0 : null,
        signal, command: "script-check", spawnError, stderr: null,
      };
      try {
        if (hooks.onDone) hooks.onDone(result);
      } catch (err) {
        // done never rejects: a hook error surfaces as an uncaught error.
        process.nextTick(() => { throw err; });
      }
      resolve(result);
    };

    limitTimer = setTimer(() => {
      limitHit = true;
      if (current) current.terminate();
    }, timeLimitSec * 1000);

    execute().then(
      () => {
        if (stopSignal) finish("fail", stopSignal, null);
        else finish(limitHit ? "timeout" : "ok", null, null);
      },
      (err) => finish("fail", null, err),
    );
  });

  const kill = (signal) => {
    stopSignal = signal || "SIGTERM";
    if (current) current.terminate();
    return true;
  };

  return { kill, done, child: null };
}

module.exports = { startScriptRun, formatReport };
