"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { makeMediaFixtures } = require("./media-fixtures");


async function request(base, pathname, options) {
  const response = await fetch(base + pathname, options);
  const body = response.headers.get("content-type")?.includes("json")
    ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { response, body };
}

function writeLine(root, attemptId = "attempt-2", evidenceAttemptId = attemptId) {
  const lineDir = path.join(root, "line-1");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree, { recursive: true });
  makeMediaFixtures(worktree);
  fs.writeFileSync(path.join(worktree, "bad.webm"), Buffer.alloc(2048, 9));
  fs.mkdirSync(lineDir, { recursive: true });
  const oldVideo = path.join(worktree, "demo.webm");
  const oldImage = path.join(worktree, "one.png");
  fs.writeFileSync(path.join(lineDir, "line.json"), JSON.stringify({
    id: "line-1", name: "Evidence", workers: [{ id: "worker-1", name: "implementor",
      role: "implementor", worktreePath: worktree, runGeneration: 2,
      lastCompletedInvocationId: attemptId }], evidence: [
      { id: "old", kind: "showcase", version: 1, useCase: "Old", name: "demo.webm",
        path: oldVideo, by: "worker-1", at: 1, attemptId: "attempt-1",
        steps: [{ title: "Old step", explanation: "Old result", screenshot: oldImage }] },
      { id: "current", kind: "showcase", version: 1, useCase: "Current", name: "demo.webm",
        path: oldVideo, by: "worker-1", at: 2, attemptId: evidenceAttemptId,
        steps: [{ title: "Current step", explanation: "Current result", screenshot: oldImage },
          { title: "JPEG step", explanation: "JPEG result", screenshot: path.join(worktree, "one.jpg") }] },
    ],
  }));
  return { lineDir, worktree };
}

async function start(root) {
  const port = 7950 + Math.floor(Math.random() * 100);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), LINES_DIR: root }, stdio: "ignore",
  });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/api/harnesses")).ok) return { child, base }; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGTERM");
  throw new Error("server did not start");
}

let root, server, base, worktree;
test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-api-"));
  ({ worktree } = writeLine(root));
  ({ child: server, base } = await start(root));
});

test.after(() => {
  if (server) server.kill("SIGTERM");
  fs.rmSync(root, { recursive: true, force: true });
});

test("serves current evidence and separate historical evidence", async () => {
  const { response, body } = await request(base, "/api/lines/line-1/evidence");
  assert.equal(response.status, 200);
  assert.deepEqual(body.items.map((item) => item.id), ["current"]);
  assert.deepEqual(body.history.map((item) => item.id), ["old"]);
  assert.equal(body.items[0].attemptId, "attempt-2");
  assert.match(body.history[0].video, /\/api\/lines\/line-1\/evidence\/old\/video$/);
  assert.match(body.history[0].steps[0].screenshot, /\/old\/steps\/0\/screenshot$/);
});

test("delivers screenshots, JPEG types, video ranges, and route errors", async () => {
  const screenshot = await request(base, "/api/lines/line-1/evidence/current/steps/0/screenshot");
  assert.equal(screenshot.response.status, 200);
  assert.equal(screenshot.response.headers.get("content-type"), "image/png");
  assert.deepEqual(screenshot.body, fs.readFileSync(path.join(worktree, "one.png")));
  const jpeg = await request(base, "/api/lines/line-1/evidence/current/steps/1/screenshot");
  assert.equal(jpeg.response.status, 200);
  assert.equal(jpeg.response.headers.get("content-type"), "image/jpeg");
  const range = await request(base, "/api/lines/line-1/evidence/current/video", { headers: { Range: "bytes=0-3" } });
  assert.equal(range.response.status, 206);
  assert.equal(range.response.headers.get("content-type"), "video/webm");
  assert.equal(range.body.length, 4);
  assert.equal((await request(base, "/api/lines/line-1/evidence/nope/video")).response.status, 404);
  assert.equal((await request(base, "/api/lines/line-1/evidence/current/steps/9/screenshot")).response.status, 404);
  assert.equal((await request(base, "/api/lines/line-1/evidence/current/steps/0/screenshot")).response.status, 200);
});

test("registers and serves legacy evidence without steps", async () => {
  const result = await request(base, "/api/protocol/workers/worker-1/evidence", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ useCase: "Legacy demo", file: "demo.webm" }),
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.attemptId, "attempt-2");
  const listing = await request(base, "/api/lines/line-1/evidence");
  const item = listing.body.items.find((entry) => entry.id === result.body.evidenceId);
  assert.equal(item.useCase, "Legacy demo");
  assert.equal(item.kind, undefined);
  assert.equal(item.steps, undefined);
  const video = await request(base, item.video);
  assert.equal(video.response.status, 200);
  assert.ok(video.body.length > 1024);
});

test("rejects invalid evidence without a partial record write", async () => {
  const before = JSON.parse(fs.readFileSync(path.join(root, "line-1", "line.json"), "utf8"));
  const result = await request(base, "/api/protocol/workers/worker-1/evidence", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ useCase: "Bad", file: "bad.webm" }),
  });
  assert.equal(result.response.status, 400);
  const after = JSON.parse(fs.readFileSync(path.join(root, "line-1", "line.json"), "utf8"));
  assert.equal(after.evidence.length, before.evidence.length);
});

test("keeps current items empty after a later attempt and reloads history", async () => {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  writeLine(root, "attempt-3", "attempt-2");
  const restarted = await start(root);
  server = restarted.child; base = restarted.base;
  const { body } = await request(base, "/api/lines/line-1/evidence");
  assert.deepEqual(body.items, []);
  assert.deepEqual(body.history.map((item) => item.id), ["old", "current"]);
  assert.equal(body.history[1].attemptId, "attempt-2");
});
