"use strict";

// Focused server tests for the harness metadata API. They boot the real
// router as a child process with fake `pi` and `vibe` executables on PATH
// and assert the HTTP contract of GET /api/harnesses and
// GET /api/harnesses/pi. Unit scope only: no integration or browser tests.

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

let server = null;
let baseUrl = null;
let tmpDir = null;
let piLog = null;
let failFlag = null;
let listFailFlag = null;

const PI_CATALOG = [
  "Provider  Model",
  "--------------------",
  "anthropic   claude-sonnet-4",
  "openai      gpt-5",
].join("\n");

function writeFakeClis(binDir) {
  const piLogPath = path.join(tmpDir, "pi-calls.log");
  const failFlag = path.join(tmpDir, "pi-auth-fails");
  const listFailFlag = path.join(tmpDir, "pi-list-fails");
  const pi = `#!/bin/sh
printf '%s\\n' "$@" >> "${piLogPath}"
printf -- '---\\n' >> "${piLogPath}"
if [ "$1" = "--version" ]; then echo "pi 0.87.1"; exit 0; fi
if [ "$1" = "--list-models" ]; then
  if [ -e "${listFailFlag}" ]; then echo "Failed to load catalog"; exit 1; fi
  printf '${PI_CATALOG.replace(/\n/g, "\\n")}\\n'
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "check" ]; then
  if [ -e "${failFlag}" ]; then echo "not logged in"; exit 1; fi
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
  return { piLogPath, failFlag, listFailFlag };
}

function piCalls() {
  const raw = fs.readFileSync(piLog, "utf8");
  return raw.split("---\n").map((block) =>
    block.split("\n").map((l) => l.trim()).filter(Boolean));
}

async function getJson(pathname) {
  const res = await fetch(baseUrl + pathname);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-api-test-"));
  const binDir = path.join(tmpDir, "bin");
  fs.mkdirSync(binDir);
  piLog = writeFakeClis(binDir).piLogPath;
  failFlag = path.join(tmpDir, "pi-auth-fails");
  listFailFlag = path.join(tmpDir, "pi-list-fails");
  const port = 7900 + Math.floor(Math.random() * 100);
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

test("base endpoint: pi carries authModes, vibe carries models", async () => {
  const { status, body } = await getJson("/api/harnesses");
  assert.strictEqual(status, 200);
  const pi = body.harnesses.find((h) => h.id === "pi");
  const vibe = body.harnesses.find((h) => h.id === "vibe");
  assert.deepStrictEqual(pi.authModes, [
    { value: "anthropic", label: "anthropic" },
    { value: "openai", label: "openai" },
  ]);
  assert.deepStrictEqual(pi.models, [
    { value: "anthropic/claude-sonnet-4", label: "claude-sonnet-4" },
    { value: "openai/gpt-5", label: "gpt-5" },
  ]);
  assert.strictEqual(pi.auth, "unknown");
  assert.ok(Array.isArray(vibe.models) && vibe.models.length >= 2);
  assert.ok(vibe.models.every((m) => m.value && m.label));
});

test("base probe never runs a provider-free pi auth check", () => {
  const calls = piCalls();
  for (const args of calls) {
    const isAuthCheck = args[0] === "auth" && args[1] === "check";
    if (isAuthCheck) {
      assert.fail(`provider-free pi auth call: ${args.join(" ")}`);
    }
  }
  assert.ok(calls.some((args) => args[0] === "--list-models"));
});

test("pi detail returns the fixed contract for a known provider", async () => {
  const { status, body } = await getJson("/api/harnesses/pi?provider=anthropic");
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, {
    id: "pi",
    authMode: "anthropic",
    auth: "ok",
    loginHint: "run pi /login",
    models: [{ value: "anthropic/claude-sonnet-4", label: "claude-sonnet-4" }],
  });
  assert.ok(!JSON.stringify(body).includes("sk-secret"));
});

test("pi detail runs the auth check with an argument array", () => {
  const calls = piCalls().filter((args) => args[0] === "auth");
  assert.ok(calls.length >= 1);
  assert.deepStrictEqual(calls[calls.length - 1],
    ["auth", "check", "--provider", "anthropic", "--json"]);
});

test("pi detail isolates providers: no cross-provider results", async () => {
  const a = await getJson("/api/harnesses/pi?provider=anthropic");
  const b = await getJson("/api/harnesses/pi?provider=openai");
  assert.strictEqual(a.body.authMode, "anthropic");
  assert.strictEqual(b.body.authMode, "openai");
  assert.deepStrictEqual(b.body.models,
    [{ value: "openai/gpt-5", label: "gpt-5" }]);
  assert.notDeepStrictEqual(a.body.models, b.body.models);
});

test("pi detail reports missing auth when the check fails", async () => {
  fs.writeFileSync(failFlag, "");
  try {
    const { status, body } = await getJson("/api/harnesses/pi?provider=openai");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.auth, "missing");
  } finally {
    fs.rmSync(failFlag, { force: true });
  }
});

test("pi detail rejects a missing provider with 400", async () => {
  const { status, body } = await getJson("/api/harnesses/pi");
  assert.strictEqual(status, 400);
  assert.match(body.error, /provider query parameter is required/);
});

test("pi detail rejects an unknown provider with 400", async () => {
  const { status, body } = await getJson("/api/harnesses/pi?provider=gemini");
  assert.strictEqual(status, 400);
  assert.match(body.error, /unknown provider 'gemini'/);
  assert.match(body.error, /anthropic, openai/);
});

test("base probe keeps the 30-second cache", async () => {
  const before = piCalls().filter((args) => args[0] === "--list-models").length;
  await getJson("/api/harnesses");
  await getJson("/api/harnesses");
  const afterCached = piCalls().filter((args) => args[0] === "--list-models").length;
  assert.strictEqual(afterCached, before, "cached requests must not re-probe");
  await getJson("/api/harnesses?refresh=1");
  const afterRefresh = piCalls().filter((args) => args[0] === "--list-models").length;
  assert.strictEqual(afterRefresh, before + 1, "?refresh=1 must re-probe");
});

test("a failed catalog command yields no providers over HTTP", async () => {
  fs.writeFileSync(listFailFlag, "");
  try {
    const { status, body } = await getJson("/api/harnesses?refresh=1");
    assert.strictEqual(status, 200);
    const pi = body.harnesses.find((h) => h.id === "pi");
    assert.deepStrictEqual(pi.authModes, []);
    assert.deepStrictEqual(pi.models, []);
    assert.ok(!JSON.stringify(body).includes("Failed"));
    // The detail route rejects every provider while the catalog is empty.
    const detail = await getJson("/api/harnesses/pi?provider=anthropic");
    assert.strictEqual(detail.status, 400);
    assert.match(detail.body.error, /pi is not installed or reported no providers/);
  } finally {
    fs.rmSync(listFailFlag, { force: true });
  }
  const recovered = await getJson("/api/harnesses?refresh=1");
  const pi = recovered.body.harnesses.find((h) => h.id === "pi");
  assert.strictEqual(pi.authModes.length, 2);
});
