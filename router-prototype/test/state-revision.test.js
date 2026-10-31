"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const post = (url, body) => fetch(url, { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "state-revision-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "vibe"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
  const lineDir = path.join(root, "seeded");
  fs.mkdirSync(lineDir);
  const lineFile = path.join(lineDir, "line.json");
  fs.writeFileSync(lineFile, JSON.stringify({ id: "seeded", name: "seeded", started: true,
    planApproved: false, workers: [], repos: [], inventory: [], evidence: [], pendingValidations: [],
    plannerQueue: [{ id: "u1", text: "one", source: null, fromUser: true, userText: "one" }],
    activePlannerRequest: { id: "act", text: "active", source: null } }));
  const port = 8700 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), LINES_DIR: root, PATH: `${bin}:${process.env.PATH}` },
    stdio: "ignore" });
  const base = `http://localhost:${port}`;
  t.after(() => { child.kill("SIGTERM"); fs.rmSync(root, { recursive: true, force: true }); });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/api/lines")).ok) break; } catch {}
    await wait(25);
  }
  const events = [];
  let raw = "";
  const request = http.get(base + "/api/events", (response) => {
    response.on("data", (chunk) => {
      raw += chunk;
      events.length = 0;
      for (const m of raw.matchAll(/^data: (.*)$/gm)) events.push(JSON.parse(m[1]));
    });
  });
  t.after(() => request.destroy());
  const until = async (fn) => {
    for (let i = 0; i < 200; i++) { if (fn()) return; await wait(25); }
    throw new Error("timed out");
  };
  await until(() => events.some((e) => e.type === "snapshot_end"));
  const states = (id) => events.filter((e) => e.type === "state" && e.lineId === id).map((e) => e.data);
  return { base, states, until, lineFile };
}

test("state revision protocol", async (t) => {
  const { base, states, until, lineFile } = await setup(t);

  await t.test("initial stream state has stateEpoch and stateRevision", () => {
    const [initial] = states("seeded");
    assert.equal(typeof initial.stateEpoch, "string");
    assert.ok(Number.isInteger(initial.stateRevision) && initial.stateRevision > 0);
  });

  await t.test("published states increase strictly, per line, with one epoch", async () => {
    const other = await (await post(base + "/api/lines", { name: "other" })).json();
    await until(() => states(other.id).length >= 1);
    const first = states("seeded").length;
    const otherFirst = states(other.id)[0];
    assert.equal(otherFirst.stateRevision, 1);
    for (let i = 0; i < 2; i++) {
      assert.equal((await post(`${base}/api/lines/seeded/prompts`, { text: "p" + i })).status, 202);
    }
    await until(() => states("seeded").length >= first + 2);
    const revs = states("seeded").map((s) => s.stateRevision);
    for (let i = 1; i < revs.length; i++) assert.ok(revs[i] > revs[i - 1]);
    assert.equal(states(other.id).length, 1);
    const epochs = new Set([...states("seeded"), ...states(other.id)].map((s) => s.stateEpoch));
    assert.equal(epochs.size, 1);
  });

  await t.test("POST prompt response keeps old fields and adds the revision stamp", async () => {
    const res = await post(`${base}/api/lines/seeded/prompts`, { text: "stamp" });
    const body = await res.json();
    assert.equal(res.status, 202);
    assert.equal(body.queued, true);
    assert.equal(typeof body.position, "number");
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
    await until(() => states("seeded").some((s) => s.queuedUserPrompts.some((r) => r.id === body.requestId)));
    const last = states("seeded").at(-1);
    assert.equal(body.stateEpoch, last.stateEpoch);
    assert.equal(body.stateRevision, last.stateRevision);
  });

  await t.test("DELETE response matches the streamed state; failed DELETE sends nothing", async () => {
    const count = states("seeded").length;
    for (const [id, status] of [["nope", 404], ["act", 409]]) {
      const res = await fetch(`${base}/api/lines/seeded/prompts/${id}`, { method: "DELETE" });
      assert.equal(res.status, status);
    }
    await wait(100);
    assert.equal(states("seeded").length, count);
    const res = await fetch(`${base}/api/lines/seeded/prompts/u1`, { method: "DELETE" });
    const body = await res.json();
    assert.equal(res.status, 200);
    await until(() => states("seeded").length > count);
    const sent = states("seeded").at(-1);
    assert.equal(body.stateEpoch, sent.stateEpoch);
    assert.equal(body.stateRevision, sent.stateRevision);
    assert.equal(states("seeded").length, count + 1);
  });

  await t.test("revision is not saved in the line file", () => {
    const saved = fs.readFileSync(lineFile, "utf8");
    assert.equal(saved.includes("stateRevision"), false);
    assert.equal(saved.includes("stateEpoch"), false);
  });
});
