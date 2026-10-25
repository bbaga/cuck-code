"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");

async function choosePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  if (port === 7788) return choosePort();
  return port;
}
function pass(step, detail = "ok") { console.log(`PASS: ${step} - ${detail}`); }
function fail(step, error) { console.error(`FAIL: ${step} - ${error.message}`); process.exitCode = 1; }
async function run() {
  const port = await choosePort();
  const linesDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-acceptance-"));
  const base = `http://127.0.0.1:${port}`;
  let child;
  const start = async () => {
    child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: { ...process.env, PORT: String(port), LINES_DIR: linesDir }, stdio: "ignore",
    });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode != null) throw new Error(`router exited with ${child.exitCode}`);
      try { const response = await fetch(`${base}/api/lines`); if (response.ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("router did not start");
  };
  const stop = async () => {
    if (!child || child.exitCode != null) return;
    child.kill("SIGTERM");
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
  };
  const call = async (method, endpoint, data) => {
    const response = await fetch(base + endpoint, { method, headers: data ? { "content-type": "application/json" } : {}, body: data ? JSON.stringify(data) : undefined });
    let body = {}; try { body = await response.json(); } catch {}
    return { status: response.status, body };
  };
  const check = async (step, fn) => { try { await fn(); pass(step); } catch (error) { fail(step, error); throw error; } };
  const createLine = async name => {
    const result = await call("POST", "/api/lines", { name });
    if (result.status !== 201 || !result.body.id) throw new Error(`line creation returned ${result.status}`);
    return result.body.id;
  };
  try {
    await start();
    let source, target, revision, claimId, secondClaimId, requestId;
    await check("create two lines", async () => { source = await createLine("Registry acceptance source"); target = await createLine("Registry acceptance target"); });
    await check("publish a claim", async () => {
      const snap = await call("GET", "/api/registry/claims");
      revision = snap.body.snapshotRevision;
      const result = await call("POST", `/api/registry/lines/${source}/claims`, { expectedSnapshotRevision: revision, claim: { repo: "example/repo", branch: "feature/test", commit: "a".repeat(40), title: "Registry acceptance claim", summary: "Acceptance check" } });
      if (result.status !== 200 || !result.body.id) throw new Error(`claim returned ${result.status}`);
      claimId = result.body.id;
      const after = await call("GET", "/api/registry/claims");
      const another = await call("POST", `/api/registry/lines/${source}/claims`, { expectedSnapshotRevision: after.body.snapshotRevision, claim: { repo: "example/repo", branch: "feature/page-two", commit: "c".repeat(40), title: "Registry page two" } });
      if (another.status !== 200 || !another.body.id) throw new Error(`second claim returned ${another.status}`);
      secondClaimId = another.body.id;
    });
    await check("reject a stale revision", async () => {
      const result = await call("POST", `/api/registry/lines/${source}/claims`, { expectedSnapshotRevision: revision, claim: { repo: "example/repo", branch: "feature/stale", commit: "b".repeat(40), title: "Stale claim" } });
      if (result.status !== 409 || !Number.isSafeInteger(result.body.snapshotRevision)) throw new Error(`expected 409 with current revision; got ${result.status}`);
    });
    await check("traverse claim pages", async () => {
      const first = await call("GET", "/api/registry/claims?page=1&pageSize=1");
      if (first.body.items.length !== 1 || !first.body.hasMore) throw new Error("first page does not report a next page");
      const second = await call("GET", "/api/registry/claims?page=2&pageSize=1");
      if (!second.body.items.some(item => item.id === claimId || item.id === secondClaimId)) throw new Error("claim is not available on page two");
    });
    await check("find claim from the second line", async () => {
      const result = await call("GET", `/api/registry/claims?q=${encodeURIComponent("Registry acceptance claim")}`);
      if (!result.body.items.some(item => item.id === claimId)) throw new Error("claim search did not find the claim");
    });
    await check("open and answer a request", async () => {
      const snap = await call("GET", "/api/registry/requests");
      const opened = await call("POST", `/api/registry/lines/${source}/requests`, { expectedSnapshotRevision: snap.body.snapshotRevision, targetLineId: target, idempotencyKey: `accept-${Date.now()}`, text: "Please review this claim." });
      if (opened.status !== 200 || !opened.body.id) throw new Error(`request open returned ${opened.status}`);
      requestId = opened.body.id;
      const current = await call("GET", "/api/registry/requests");
      const request = current.body.items.find(item => item.id === requestId);
      const answered = await call("PATCH", `/api/registry/lines/${target}/requests/${requestId}`, { expectedSnapshotRevision: current.body.snapshotRevision, expectedRevision: request.revision, state: "accepted" });
      if (answered.status !== 200 || answered.body.state !== "accepted") throw new Error(`request response returned ${answered.status}`);
    });
    await check("preserve claim and request after router restart", async () => {
      await stop(); await start();
      const claims = await call("GET", "/api/registry/claims?q=Registry%20acceptance%20claim");
      const requests = await call("GET", "/api/registry/requests");
      if (!claims.body.items.some(item => item.id === claimId)) throw new Error("claim did not persist");
      if (!requests.body.items.some(item => item.id === requestId && item.state === "accepted")) throw new Error("accepted request did not persist");
    });
  } catch (error) { if (process.exitCode !== 1) fail("acceptance run", error); }
  finally { await stop(); fs.rmSync(linesDir, { recursive: true, force: true }); }
  if (process.exitCode === 1) process.exitCode = 1;
}
if (require.main === module) run();
module.exports = { choosePort };
