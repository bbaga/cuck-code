"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { startRouter, stopRouter } = require("./fixtures/router-process");

const FIXTURE = path.join(__dirname, "fixtures", "router-process.js");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) {
    if (err.code === "ESRCH") return false;
    throw err;
  }
}

async function waitGone(pid, limitMs) {
  const end = Date.now() + limitMs;
  while (alive(pid) && Date.now() < end) await sleep(50);
  return !alive(pid);
}

// Runs a helper script in a node child. Cleanup kills the helper and its router.
function runHelper(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-cleanup-test-"));
  const root = path.join(dir, "lines");
  fs.mkdirSync(root);
  const script = path.join(dir, "helper.js");
  fs.writeFileSync(script, `
    const { startRouter } = require(${JSON.stringify(FIXTURE)});
    (async () => {
      const router = await startRouter(${JSON.stringify(root)});
      console.log("ROUTER_PID=" + router.child.pid);
      ${body}
    })().catch((err) => { console.error(err); process.exit(1); });
  `);
  const helper = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
  const state = { helper, routerPid: null, out: "", exited: null };
  state.exited = new Promise((resolve) => helper.once("exit", (code, signal) => resolve({ code, signal })));
  state.pidKnown = new Promise((resolve, reject) => {
    helper.stdout.on("data", (chunk) => {
      state.out += chunk;
      const match = /ROUTER_PID=(\d+)/.exec(state.out);
      if (match && !state.routerPid) { state.routerPid = Number(match[1]); resolve(state.routerPid); }
    });
    helper.once("exit", () => reject(new Error("helper exited before it printed the router pid")));
  });
  state.pidKnown.catch(() => {});
  t.after(async () => {
    if (helper.exitCode === null && helper.signalCode === null) helper.kill("SIGKILL");
    if (state.routerPid && alive(state.routerPid)) {
      try { process.kill(state.routerPid, "SIGKILL"); } catch {}
    }
    await state.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return state;
}

test("a test process that exits without stopRouter also stops its router", async (t) => {
  // The helper never calls stopRouter. It ends the process with process.exit(0).
  const state = runHelper(t, "process.exit(0);");
  const timer = setTimeout(() => state.helper.kill("SIGKILL"), 20_000);
  t.after(() => clearTimeout(timer));
  const { code, signal } = await state.exited;
  assert.equal(signal, null, "helper was killed: it did not exit");
  assert.equal(code, 0);
  assert.ok(state.routerPid, "helper printed the router pid");
  assert.ok(await waitGone(state.routerPid, 10_000), "router is gone (ESRCH) within 10 s");
});

test("SIGTERM to the test process also stops its router", async (t) => {
  const state = runHelper(t, "setInterval(() => {}, 1000);");
  const routerPid = await state.pidKnown;
  assert.ok(alive(routerPid), "router runs before the signal");
  state.helper.kill("SIGTERM");
  assert.ok(await waitGone(routerPid, 10_000), "router is gone within 10 s");
});

test("stopRouter still stops a router and resolves after its exit", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "router-cleanup-test-"));
  const router = await startRouter(root);
  t.after(async () => {
    await stopRouter(router);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const pid = router.child.pid;
  assert.ok(alive(pid));
  await stopRouter(router);
  assert.notEqual(router.child.exitCode === null && router.child.signalCode === null, true);
  assert.equal(alive(pid), false);
});
