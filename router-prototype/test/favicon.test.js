"use strict";

// Unit tests for the SVG favicon route and the favicon link in the UI
// page. They boot the real router as a child process with fake `pi` and
// `vibe` executables on PATH and assert the HTTP contract of
// GET /favicon.svg and GET /. Unit scope only.

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

let server = null;
let baseUrl = null;
let tmpDir = null;

function writeFakeClis(binDir) {
  const pi = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "pi 0.87.1"; exit 0; fi
if [ "$1" = "--list-models" ]; then
  printf 'Provider  Model\\n--------------------\\nanthropic   claude-sonnet-4\\n'
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "check" ]; then
  echo '{"loginHint":"run pi /login","apiKey":"sk-secret"}'
  exit 0
fi
exit 1
`;
  const vibe = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "vibe 3.0.2"; exit 0; fi
exit 1
`;
  fs.writeFileSync(path.join(binDir, "pi"), pi, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "vibe"), vibe, { mode: 0o755 });
}

async function waitUntilListening(url, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url + "/api/harnesses");
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "favicon-test-"));
  const binDir = path.join(tmpDir, "bin");
  fs.mkdirSync(binDir);
  writeFakeClis(binDir);
  const port = 8100 + Math.floor(Math.random() * 100);
  baseUrl = `http://localhost:${port}`;
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      LINES_DIR: path.join(tmpDir, "lines"),
      PATH: `${binDir}:${process.env.PATH}`,
    },
    stdio: "ignore",
  });
  await waitUntilListening(baseUrl);
});

after(() => {
  if (server) server.kill("SIGTERM");
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("GET /favicon.svg serves the svg with the right content type", async () => {
  const res = await fetch(baseUrl + "/favicon.svg");
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("content-type"), "image/svg+xml");
  const body = await res.text();
  assert.ok(body.includes("<svg"), "body must contain an <svg root");
  assert.ok(body.includes("viewBox"), "svg must have a viewBox");
});

test("GET / includes the favicon link", async () => {
  const res = await fetch(baseUrl + "/");
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/);
});