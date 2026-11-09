"use strict";

// The registry writes in the background only when the router runs as a
// process. A test that requires the server must see no write after cleanup.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { startRouter, stopRouter, wait } = require("./fixtures/router-process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-quiesce-"));
const linesDir = path.join(root, "lines");
fs.mkdirSync(linesDir);
process.env.LINES_DIR = linesDir;
const server = require("../server");
const rmOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 };

after(async () => {
  server.stopRegistryLoopsForTest();
  await server.registryIdle();
  fs.rmSync(root, rmOptions);
});

const coordinationFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((name) => name.startsWith("work-coordination.json"));

test("requiring the server starts no registry write", async () => {
  await server.registryIdle();
  await wait(500);
  assert.deepEqual(coordinationFiles(linesDir), []);
});

test("after registryIdle a claim write leaves no later write", async () => {
  const item = { id: "L1", name: "quiesce", status: "idle", deleted: false, started: true, queue: [], transcript: [],
    workers: new Map(), clients: new Set(), inventory: new Map(), pendingValidations: [],
    repos: new Map([["r", { name: "r", url: "https://github.com/o/r.git" }]]) };
  server.lines.set(item.id, item);
  const http1 = http.createServer(server.requestHandler);
  await new Promise((resolve) => http1.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${http1.address().port}/api/registry/lines/L1/claims`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "T", repo: "r", branch: "b", commit: "a".repeat(40) }),
    });
    assert.equal(res.status, 201, JSON.stringify(await res.json()));
  } finally {
    http1.close();
    server.lines.delete(item.id);
  }
  await server.registryIdle();
  fs.rmSync(linesDir, rmOptions);
  await wait(300);
  assert.equal(fs.existsSync(linesDir), false, "a background write made the folder again");
});

test("a router process is quiet after registry.ready", { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-quiesce-proc-"));
  const router = await startRouter(dir);
  try {
    fs.rmSync(dir, rmOptions);
    fs.mkdirSync(dir);
    await wait(500);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(router.child.exitCode, null, "router process must stay alive");
  } finally {
    await stopRouter(router);
    fs.rmSync(dir, rmOptions);
  }
});
