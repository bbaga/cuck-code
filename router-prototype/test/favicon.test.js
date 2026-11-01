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
const { startRouter, stopRouter } = require("./fixtures/router-process");

let router = null;
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

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "favicon-test-"));
  const binDir = path.join(tmpDir, "bin");
  fs.mkdirSync(binDir);
  writeFakeClis(binDir);
  router = await startRouter(path.join(tmpDir, "lines"), { PATH: `${binDir}:${process.env.PATH}` });
  baseUrl = router.base;
});

after(async () => {
  if (router) await stopRouter(router);
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("GET /favicon.svg serves the svg with the right content type", { timeout: 30_000 }, async () => {
  const res = await fetch(baseUrl + "/favicon.svg");
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("content-type"), "image/svg+xml");
  const body = await res.text();
  assert.ok(body.includes("<svg"), "body must contain an <svg root");
  assert.ok(body.includes("viewBox"), "svg must have a viewBox");
});

test("GET / includes the favicon link", { timeout: 30_000 }, async () => {
  const res = await fetch(baseUrl + "/");
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/);
});

test("GET / shows the logo img before the text in the sidebar h1", { timeout: 30_000 }, async () => {
  const res = await fetch(baseUrl + "/");
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  const h1 = html.match(/<h1>([\s\S]*?)<\/h1>/);
  assert.ok(h1, "html must contain an h1");
  assert.ok(
    h1[1].indexOf('<img src="/favicon.svg" alt="">') < h1[1].indexOf("cuck-code"),
    "the logo img must come before the text cuck-code",
  );
});