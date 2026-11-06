"use strict";

// The SDK object handed to harness plugin factories (interface v1). It owns
// the process plumbing every JSONL-speaking CLI needs, so a plugin only
// supplies argv and a small parser. Spawn, runCommand and getBuiltin are
// injected so the server can keep setSpawnForTest working.

const childProcess = require("node:child_process");
const { JsonlDecoder, parseJsonRecord } = require("./jsonl");
const { StderrCapture } = require("./run-failure");

function missingBuiltin() {
  throw new Error("built-in harnesses are not registered");
}

// Same behavior as runProbe in server.js: resolves { code, stdout }, or null
// when the command cannot start or times out (the child gets SIGKILL).
function defaultRunCommand(argv, { timeoutMs = 2000 } = {}, spawn = childProcess.spawn) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return resolve(null);
    }
    let stdout = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", (c) => { stdout += c; });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish({ code, stdout }));
  });
}

// Key of the router-only synchronous settle hook on a run from spawnJsonl.
const ON_SETTLE = Symbol("harness.run.onSettle");

function createSdk({
  spawn = childProcess.spawn,
  runCommand = defaultRunCommand,
  getBuiltin = missingBuiltin,
} = {}) {
  // Spawns spec.cmd and feeds each JSONL record of stdout to parser.record.
  // The router-owned sink is passed through to the parser callbacks.
  // A synchronous spawn throw is rethrown: the caller reports "could not start".
  function spawnJsonl(spec, parser, sink) {
    const options = { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...spec.env } };
    if (spec.cwd !== undefined) options.cwd = spec.cwd;
    const child = spawn(spec.cmd, spec.args || [], options);

    const decoder = new JsonlDecoder();
    const stderr = new StderrCapture();
    let spawnError = null;

    const handleRecords = (records) => {
      for (const text of records) {
        const obj = parseJsonRecord(text);
        if (obj !== null) parser.record(obj, sink);
      }
    };

    child.stdout.on("data", (chunk) => handleRecords(decoder.push(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (err) => { spawnError = err; });

    let settled = null;
    const settleCallbacks = [];
    const done = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        let outcome = "fail";
        try {
          handleRecords(decoder.finish());
          parser.end(sink);
          if (!spawnError) outcome = parser.outcome(code, signal);
        } catch (err) {
          // A parser bug must not leave done pending or rejected.
          spawnError = spawnError || err;
          outcome = "fail";
        }
        settled = {
          outcome,
          exitCode: typeof code === "number" ? code : null,
          signal: signal || null,
          command: spec.cmd,
          spawnError,
          stderr: stderr.text(),
        };
        resolve(settled);
        // Settle callbacks run in the close event itself, so the router can
        // finish a run without waiting for a promise tick. A callback error
        // is not caught: it reaches the event emitter, as an error in a
        // direct close handler did.
        for (const cb of settleCallbacks.splice(0)) cb(settled);
      });
    });

    const run = {
      stop(signal = "SIGTERM") {
        try { return child.kill(signal); } catch { return false; }
      },
      done,
    };
    Object.defineProperty(run, "child", { value: child, enumerable: true, writable: false });
    // Router-only hook (not part of the plugin contract): cb(result) runs
    // synchronously when the run settles, or at once if it already did.
    Object.defineProperty(run, ON_SETTLE, { value: (cb) => {
      if (settled) cb(settled); else settleCallbacks.push(cb);
    } });
    return run;
  }

  return { apiVersion: 1, spawnJsonl, runCommand, builtin: getBuiltin };
}

module.exports = { createSdk, defaultRunCommand, ON_SETTLE };
