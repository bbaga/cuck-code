"use strict";

// Boot registration of the built-in harnesses and the settings checks that
// read the registry (validateNodeSettings and the spawn body check).

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-boot-"));
fs.mkdirSync(path.join(root, "lines"));
process.env.LINES_DIR = path.join(root, "lines");
const server = require("../server");
const registry = require("../harness-registry");
const { bootHarnesses } = require("../harness-boot");
const { validateNodeSettings } = require("../pipeline-config");

after(async () => {
  await server.registryIdle();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function fakePlugin(id) {
  const noop = async () => ({});
  return {
    apiVersion: 1, id,
    capabilities: { resume: true, systemPrompt: "none", nativeTimeLimit: false, providers: false },
    probe: noop, listModels: async () => [],
    startSession() {}, resumeSession() {},
  };
}

function withFakePlugin(id, fn) {
  registry.registerHarness(fakePlugin(id), { layer: "user", folder: root });
  return Promise.resolve(fn()).finally(() => registry.unregisterPluginHarnesses());
}

test("bootHarnesses registers the built-ins once", () => {
  const first = bootHarnesses();
  const second = bootHarnesses();
  assert.equal(first, second);
  assert.deepEqual(registry.harnessIds(), ["vibe", "pi", "codex", "claude"]);
});

test("bootHarnesses registers again after the registry reset", () => {
  registry.resetRegistryForTest();
  bootHarnesses();
  assert.deepEqual(registry.harnessIds(), ["vibe", "pi", "codex", "claude"]);
});

test("validateNodeSettings keeps the message for built-ins and unknown ids", () => {
  assert.equal(validateNodeSettings("node 'A'", { harness: "claude" }), null);
  assert.equal(validateNodeSettings("node 'A'", { harness: "nope" }),
    "node 'A'.harness must be one of: vibe, pi, codex, claude");
});

test("validateNodeSettings accepts a registered plugin and lists it", () =>
  withFakePlugin("remote-claude", () => {
    assert.equal(validateNodeSettings("node 'A'", { harness: "remote-claude" }), null);
    assert.equal(validateNodeSettings("node 'A'", { harness: "nope" }),
      "node 'A'.harness must be one of: vibe, pi, codex, claude, remote-claude");
  }));

async function spawnWithHarness(harness) {
  const item = { id: "boot-line", name: "boot", status: "idle", deleted: false, started: true,
    planApproved: true, queue: [], transcript: [], workers: new Map(), clients: new Set(),
    inventory: new Map(), repos: new Map(), pendingValidations: [] };
  server.lines.set(item.id, item);
  const http1 = http.createServer(server.requestHandler);
  await new Promise((resolve) => http1.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${http1.address().port}/api/protocol/lines/boot-line/workers`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "w", prompt: "p", harness }),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    http1.close();
    server.lines.delete(item.id);
  }
}

test("the spawn body check rejects an unknown harness with the old message", async () => {
  const res = await spawnWithHarness("nope");
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "harness must be one of: vibe, pi, codex, claude");
});

test("the spawn body check accepts a registered plugin", () =>
  withFakePlugin("remote-claude", async () => {
    const res = await spawnWithHarness("remote-claude");
    // The plugin passes the id check. Install probing for plugins comes later.
    assert.doesNotMatch(String(res.body.error), /must be one of/);
  }));
