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

test("prompt API and dashboard SSE preserve identical queued user IDs and positions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-prompt-api-"));
  const bin = path.join(root, "bin");
  const lineDir = path.join(root, "seeded");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(lineDir, { recursive: true });
  const fake = path.join(bin, "vibe");
  fs.writeFileSync(fake, "#!/bin/sh\nsleep 30\n");
  fs.chmodSync(fake, 0o755);
  const userText = "repeat this exact prompt";
  fs.writeFileSync(path.join(lineDir, "line.json"), JSON.stringify({
    id: "line-seeded", name: "seeded", started: true, planApproved: false,
    plannerQueue: [{ id: "user-a", text: "wrapped A", fromUser: true, userText }],
    activePlannerRequest: { id: "internal-a", text: "internal notice", source: null },
    workers: [], repos: [], inventory: [], evidence: [], pendingValidations: [],
  }));
  const { child, base } = await start(root, { PATH: `${bin}:${process.env.PATH}` });
  t.after(() => { child.kill("SIGTERM"); fs.rmSync(root, { recursive: true, force: true }); });

  const initialStream = await openStream(base);
  let initial = "";
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for initial state")), 5000);
    initialStream.response.on("data", (chunk) => {
      initial += chunk;
      if (initial.includes('"type":"snapshot_end"')) { clearTimeout(timeout); resolve(); }
    });
    initialStream.response.on("error", reject);
  });
  initialStream.request.destroy();
  const initialState = [...initial.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]))
    .find((event) => event.type === "state" && event.lineId === "line-seeded");
  assert.deepEqual(initialState.data.queuedUserPrompts, [{ id: "user-a", text: userText, position: 1 }]);

  const stream = await openStream(base);
  let body = "";
  const states = [];
  const stateSeen = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for prompt state")), 5000);
    stream.response.on("data", (chunk) => {
      body += chunk;
      for (const match of body.matchAll(/^data: (.*)$/gm)) {
        const event = JSON.parse(match[1]);
        if (event.type === "state" && event.lineId === "line-seeded") {
          states.push(event.data);
          if (event.data.queuedUserPrompts.length === 3) { clearTimeout(timeout); resolve(); }
        }
      }
    });
    stream.response.on("error", reject);
  });
  async function prompt() {
    return fetch(base + "/api/lines/line-seeded/prompts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: userText }),
    });
  }
  const a = await prompt();
  const b = await prompt();
  const aBody = await a.json();
  const bBody = await b.json();
  assert.equal(a.status, 202); assert.equal(b.status, 202);
  assert.deepEqual([aBody.queued, bBody.queued], [true, true]);
  assert.deepEqual([aBody.position, bBody.position], [2, 3]);
  assert.match(aBody.requestId, /^[0-9a-f-]{36}$/);
  assert.match(bBody.requestId, /^[0-9a-f-]{36}$/);
  assert.notEqual(aBody.requestId, bBody.requestId);
  await stateSeen;
  const projection = states.at(-1).queuedUserPrompts;
  assert.deepEqual(projection.map((row) => row.id), ["user-a", aBody.requestId, bBody.requestId]);
  assert.deepEqual(projection.map((row) => row.text), [userText, userText, userText]);
  assert.deepEqual(projection.map((row) => row.position), [1, 2, 3]);
  for (const row of projection) assert.deepEqual(Object.keys(row).sort(), ["id", "position", "text"]);
  assert.equal(JSON.stringify(projection).includes("internal notice"), false);
  stream.request.destroy();
});

test("DELETE queued prompt uses HTTP, authoritative SSE, persistence, conflicts, and failed-save rollback", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-cancel-api-"));
  const bin = path.join(root, "bin");
  const lineDir = path.join(root, "seeded");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(lineDir, { recursive: true });
  const fake = path.join(bin, "vibe");
  fs.writeFileSync(fake, "#!/bin/sh\nsleep 30\n");
  fs.chmodSync(fake, 0o755);
  const req = (id, text, fromUser = true) => ({ id, text, source: null,
    ...(fromUser ? { fromUser: true, userText: text } : {}) });
  const first = req("user-first", "duplicate");
  const internal = req("internal-middle", "internal notice", false);
  const middle = req("user-middle", "duplicate");
  const last = req("user-last", "last");
  fs.writeFileSync(path.join(lineDir, "line.json"), JSON.stringify({
    id: "line-cancel", name: "cancel", started: true, planApproved: false,
    plannerQueue: [first, internal, middle, last],
    activePlannerRequest: { id: "active-internal", text: "active notice", source: null },
    workers: [], repos: [], inventory: [], evidence: [], pendingValidations: [],
  }));
  const { child, base } = await start(root, { PATH: `${bin}:${process.env.PATH}` });
  t.after(() => { child.kill("SIGTERM"); fs.rmSync(root, { recursive: true, force: true }); });

  const stream = await openStream(base);
  let raw = ""; const states = [];
  const initial = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for cancellation snapshot")), 5000);
    stream.response.on("data", (chunk) => {
      raw += chunk;
      for (const match of raw.matchAll(/^data: (.*)$/gm)) {
        const event = JSON.parse(match[1]);
        if (event.type === "state" && event.lineId === "line-cancel") states.push(event.data);
        if (event.type === "snapshot_end") { clearTimeout(timeout); resolve(); }
      }
    });
    stream.response.on("error", reject);
  });
  await initial;
  const initialState = states.at(-1);
  assert.deepEqual(initialState.queuedUserPrompts.map((r) => r.id), ["user-first", "user-middle", "user-last"]);
  assert.deepEqual(initialState.queuedUserPrompts.map((r) => r.position), [1, 2, 3]);

  const missingLine = await fetch(`${base}/api/lines/no-line/prompts/user-middle`, { method: "DELETE" });
  assert.equal(missingLine.status, 404);
  const active = await fetch(`${base}/api/lines/line-cancel/prompts/active-internal`, { method: "DELETE" });
  assert.equal(active.status, 409);
  const internalResult = await fetch(`${base}/api/lines/line-cancel/prompts/internal-middle`, { method: "DELETE" });
  assert.equal(internalResult.status, 409);
  const missing = await fetch(`${base}/api/lines/line-cancel/prompts/no-request`, { method: "DELETE" });
  assert.equal(missing.status, 404);
  assert.deepEqual(states.at(-1).queuedUserPrompts.map((r) => r.id), ["user-first", "user-middle", "user-last"]);

  const deletion = await fetch(`${base}/api/lines/line-cancel/prompts/user-middle`, { method: "DELETE" });
  assert.equal(deletion.status, 200);
  const deletionBody = await deletion.json();
  assert.deepEqual(deletionBody, { queuedUserPrompts: [
    { id: "user-first", text: "duplicate", position: 1 },
    { id: "user-last", text: "last", position: 2 },
  ] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for cancellation state")), 5000);
    const check = () => {
      if (states.at(-1)?.queuedUserPrompts?.length === 2) { clearTimeout(timeout); resolve(); }
      else setImmediate(check);
    }; check();
  });
  const committed = states.at(-1).queuedUserPrompts;
  assert.deepEqual(committed, [
    { id: "user-first", text: "duplicate", position: 1 },
    { id: "user-last", text: "last", position: 2 },
  ]);
  assert.deepEqual(Object.keys(committed[0]).sort(), ["id", "position", "text"]);
  assert.equal(JSON.stringify(committed).includes("internal"), false);
  const repeated = await fetch(`${base}/api/lines/line-cancel/prompts/user-middle`, { method: "DELETE" });
  assert.equal(repeated.status, 404);
  const persisted = JSON.parse(fs.readFileSync(path.join(lineDir, "line.json"), "utf8"));
  assert.deepEqual(persisted.plannerQueue.map((r) => r.id), ["user-first", "internal-middle", "user-last"]);

  // A failed durable write must not report success, broadcast, or lose the queue.
  fs.rmSync(path.join(lineDir, "line.json"));
  fs.mkdirSync(path.join(lineDir, "line.json"));
  const failed = await fetch(`${base}/api/lines/line-cancel/prompts/user-last`, { method: "DELETE" });
  assert.equal(failed.status, 500);
  assert.deepEqual(states.at(-1).queuedUserPrompts, [
    { id: "user-first", text: "duplicate", position: 1 },
    { id: "user-last", text: "last", position: 2 },
  ]);
  fs.rmSync(path.join(lineDir, "line.json"), { recursive: true });
  fs.writeFileSync(path.join(lineDir, "line.json"), JSON.stringify(persisted));
  stream.request.destroy();

  // Reload proves the successful mutation is durable and the deleted ID cannot be pumped.
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  const restarted = await start(root, { PATH: `${bin}:${process.env.PATH}` });
  t.after(() => restarted.child.kill("SIGTERM"));
  const restoredStream = await openStream(restarted.base);
  t.after(() => restoredStream.request.destroy());
  let restoredRaw = "";
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for restored state")), 5000);
    restoredStream.response.on("data", (chunk) => {
      restoredRaw += chunk;
      if (restoredRaw.includes('"type":"snapshot_end"')) { clearTimeout(timeout); resolve(); }
    });
    restoredStream.response.on("error", reject);
  });
  const restoredState = [...restoredRaw.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]))
    .find((event) => event.type === "state" && event.lineId === "line-cancel");
  assert.deepEqual(restoredState.data.queuedUserPrompts, [
    { id: "user-first", text: "duplicate", position: 1 },
    { id: "user-last", text: "last", position: 2 },
  ]);
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
