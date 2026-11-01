"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SERVER = path.join(__dirname, "..", "..", "server.js");
const NOOP_DOCKER = "#!/bin/sh\nexit 0\n";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Test routers never see the host's containers: `docker` is a stub.
function dockerBin(script) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "router-test-bin-"));
  const docker = path.join(bin, "docker");
  fs.writeFileSync(docker, script);
  fs.chmodSync(docker, 0o755);
  return bin;
}

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startRouter(root, extraEnv = {}, { docker = NOOP_DOCKER } = {}) {
  const port = await freePort();
  const bin = dockerBin(docker);
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...extraEnv, PORT: String(port), LINES_DIR: root,
      PATH: `${bin}:${extraEnv.PATH || process.env.PATH}` },
    stdio: "ignore",
  });
  const router = { child, bin, base: `http://127.0.0.1:${port}` };
  for (let i = 0; i < 200; i++) {
    try {
      const res = await fetch(router.base + "/api/lines", { signal: AbortSignal.timeout(1000) });
      await res.body?.cancel();
      if (res.ok) return router;
    } catch {}
    await wait(25);
  }
  await stopRouter(router);
  throw new Error("router did not start");
}

// SIGTERM, then SIGKILL after the grace period. Resolves after the exit.
async function stopRouter({ child, bin }, graceMs = 3000) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
    await exited;
    clearTimeout(timer);
  }
  fs.rmSync(bin, { recursive: true, force: true });
}

module.exports = { startRouter, stopRouter, wait };
