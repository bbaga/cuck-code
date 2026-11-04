"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSdk, defaultRunCommand } = require("../harness-sdk");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sdk-"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function script(name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

// A parser that records everything it sees.
function recordingParser(outcomeFn) {
  const seen = { records: [], ended: 0 };
  return {
    seen,
    record: (obj, sink) => seen.records.push({ obj, sink }),
    end: () => { seen.ended += 1; },
    outcome: outcomeFn || ((code) => (code === 0 ? "ok" : "fail")),
  };
}

const sdk = createSdk();

test("sdk exposes the v1 surface", () => {
  assert.equal(sdk.apiVersion, 1);
  assert.equal(typeof sdk.spawnJsonl, "function");
  assert.equal(typeof sdk.runCommand, "function");
  assert.throws(() => sdk.builtin("claude"), /built-in harnesses are not registered/);
});

test("builtin uses the injected getBuiltin", () => {
  const custom = createSdk({ getBuiltin: (id) => ({ id }) });
  assert.deepEqual(custom.builtin("pi"), { id: "pi" });
});

test("spawnJsonl delivers records in order and ignores non-JSON lines", async () => {
  const file = script("ok.js", `
    console.log(JSON.stringify({ n: 1 }));
    console.log("not json at all");
    console.log(JSON.stringify({ n: 2 }));
    console.error("warn: something");
    process.stdout.write(JSON.stringify({ n: 3 }));
  `);
  const parser = recordingParser();
  const sink = { tag: "sink" };
  const run = sdk.spawnJsonl({ cmd: process.execPath, args: [file], env: {} }, parser, sink);
  const result = await run.done;
  assert.deepEqual(parser.seen.records.map((r) => r.obj.n), [1, 2, 3]);
  assert.equal(parser.seen.records[0].sink, sink);
  assert.equal(parser.seen.ended, 1);
  assert.equal(result.outcome, "ok");
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.command, process.execPath);
  assert.equal(result.spawnError, null);
  assert.equal(result.stderr, "warn: something");
  assert.ok(run.child && typeof run.child.pid === "number");
});

test("spawnJsonl passes env and cwd", async () => {
  const file = script("env.js", `
    console.log(JSON.stringify({ v: process.env.SDK_TEST_VAR, cwd: process.cwd() }));
  `);
  const parser = recordingParser();
  const cwd = fs.realpathSync(dir);
  await sdk.spawnJsonl({ cmd: process.execPath, args: [file], env: { SDK_TEST_VAR: "x" }, cwd }, parser).done;
  assert.equal(parser.seen.records[0].obj.v, "x");
  assert.equal(fs.realpathSync(parser.seen.records[0].obj.cwd), cwd);
});

test("spawnJsonl reports a missing binary as fail with spawnError", async () => {
  const parser = recordingParser(() => "ok");
  const run = sdk.spawnJsonl({ cmd: path.join(dir, "no-such-binary"), args: [], env: {} }, parser);
  const result = await run.done;
  assert.equal(result.outcome, "fail");
  assert.equal(result.spawnError.code, "ENOENT");
  assert.equal(parser.seen.ended, 1);
});

test("stop(SIGTERM) ends the child and reports the signal", async () => {
  const file = script("hang.js", "setInterval(() => {}, 1000); console.log('{\"a\":1}');");
  const parser = recordingParser((code, signal) => (signal ? "timeout" : "ok"));
  const run = sdk.spawnJsonl({ cmd: process.execPath, args: [file], env: {} }, parser);
  assert.equal(run.stop(), true);
  const result = await run.done;
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.outcome, "timeout");
});

test("stop returns false when kill throws", async () => {
  const fake = fakeChild();
  const custom = createSdk({ spawn: () => fake });
  fake.kill = () => { throw new Error("boom"); };
  const run = custom.spawnJsonl({ cmd: "x", args: [], env: {} }, recordingParser());
  assert.equal(run.stop(), false);
});

function fakeChild() {
  const { EventEmitter } = require("node:events");
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

test("injected spawn is used and cwd is omitted when undefined", async () => {
  const calls = [];
  const fake = fakeChild();
  const custom = createSdk({ spawn: (...a) => { calls.push(a); return fake; } });
  const parser = recordingParser();
  const run = custom.spawnJsonl({ cmd: "tool", args: ["--x"], env: { A: "1" } }, parser);
  fake.stdout.emit("data", '{"k":1}\n');
  fake.emit("close", 0, null);
  const result = await run.done;
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "tool");
  assert.deepEqual(calls[0][1], ["--x"]);
  assert.equal("cwd" in calls[0][2], false);
  assert.equal(calls[0][2].env.A, "1");
  assert.deepEqual(calls[0][2].stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(result.outcome, "ok");
  assert.deepEqual(parser.seen.records.map((r) => r.obj), [{ k: 1 }]);
});

test("a synchronous spawn throw is rethrown", () => {
  const custom = createSdk({ spawn: () => { throw new Error("EACCES"); } });
  assert.throws(() => custom.spawnJsonl({ cmd: "x", args: [], env: {} }, recordingParser()), /EACCES/);
});

test("done resolves with fail when the parser throws", async () => {
  const fake = fakeChild();
  const custom = createSdk({ spawn: () => fake });
  const parser = recordingParser();
  parser.end = () => { throw new Error("parser bug"); };
  const run = custom.spawnJsonl({ cmd: "x", args: [], env: {} }, parser);
  fake.emit("close", 0, null);
  const result = await run.done;
  assert.equal(result.outcome, "fail");
  assert.match(result.spawnError.message, /parser bug/);
});

test("runCommand returns code and stdout on success", async () => {
  const r = await sdk.runCommand([process.execPath, "-e", "console.log('hi')"]);
  assert.deepEqual(r, { code: 0, stdout: "hi\n" });
});

test("runCommand returns a nonzero exit code", async () => {
  const r = await sdk.runCommand([process.execPath, "-e", "process.exit(3)"]);
  assert.equal(r.code, 3);
});

test("runCommand returns null on timeout", async () => {
  const r = await sdk.runCommand([process.execPath, "-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 });
  assert.equal(r, null);
});

test("runCommand returns null for a missing binary", async () => {
  assert.equal(await sdk.runCommand([path.join(dir, "no-such-binary")]), null);
});

test("defaultRunCommand returns null when spawn throws", async () => {
  const r = await defaultRunCommand(["x"], {}, () => { throw new Error("no"); });
  assert.equal(r, null);
});
