"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const http2 = require("node:http2");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function start(root, extraEnv = {}) {
  const port = 8200 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), LINES_DIR: root, ...extraEnv }, stdio: "ignore",
  });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/api/lines")).ok) return { child, base }; } catch {}
    await wait(25);
  }
  child.kill("SIGTERM");
  throw new Error("server did not start");
}

function openStream(base) {
  return new Promise((resolve, reject) => {
    const request = http.get(base + "/api/events");
    request.once("error", reject);
    request.once("response", (response) => resolve({ request, response }));
  });
}

test("shared dashboard stream bootstraps and publishes line lifecycle events", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-events-api-"));
  const { child, base } = await start(root);
  t.after(() => { child.kill("SIGTERM"); fs.rmSync(root, { recursive: true, force: true }); });

  const { request, response } = await openStream(base);
  assert.equal(response.headers["content-type"], "text/event-stream");
  let body = "";
  const received = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for dashboard events")), 5000);
    response.on("data", (chunk) => {
      body += chunk;
      if (body.includes('"type":"snapshot_end"') && body.includes('"type":"line_created"')
        && body.includes('"type":"state"')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    response.on("error", reject);
  });
  const created = await fetch(base + "/api/lines", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Streamed line" }),
  });
  assert.equal(created.status, 201);
  await received;
  request.destroy();
  const events = [...body.matchAll(/^data: (.*)$/gm)].map((match) => JSON.parse(match[1]));
  assert.deepEqual(events.slice(0, 2).map((event) => event.type), ["snapshot_begin", "snapshot_end"]);
  const lineCreated = events.find((event) => event.type === "line_created");
  const state = events.find((event) => event.type === "state" && event.lineId === lineCreated.lineId);
  assert.ok(lineCreated.lineId);
  assert.ok(state);
});

test("Node serves the dashboard stream over direct HTTP/2 when TLS is configured", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-events-h2-"));
  const key = path.join(root, "key.pem");
  const cert = path.join(root, "cert.pem");
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
      "-out", cert, "-subj", "/CN=localhost", "-days", "1"], { stdio: "ignore" });
  } catch {
    t.skip("openssl is required to generate an isolated test certificate");
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }
  const httpsPort = 8600 + Math.floor(Math.random() * 400);
  const { child } = await start(root, { HTTPS_PORT: String(httpsPort), TLS_KEY: key, TLS_CERT: cert });
  t.after(() => { child.kill("SIGTERM"); fs.rmSync(root, { recursive: true, force: true }); });

  const client = http2.connect(`https://localhost:${httpsPort}`, { rejectUnauthorized: false });
  t.after(() => client.close());
  await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("error", reject); });
  assert.equal(client.alpnProtocol, "h2");
  const stream = client.request({ ":path": "/api/events" });
  t.after(() => stream.close());
  let body = "";
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for HTTP/2 snapshot")), 5000);
    stream.on("data", (chunk) => {
      body += chunk;
      if (body.includes('"type":"snapshot_end"')) { clearTimeout(timeout); resolve(); }
    });
    stream.once("error", reject);
  });
  assert.match(body, /"type":"snapshot_begin"/);
  assert.match(body, /"type":"snapshot_end"/);
});
