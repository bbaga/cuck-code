"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const http2 = require("node:http2");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startRouter, stopRouter, wait } = require("./fixtures/router-process");

function openStream(base) {
  return new Promise((resolve, reject) => {
    const request = http.get(base + "/api/events");
    request.once("error", reject);
    request.once("response", (response) => resolve({ request, response }));
  });
}

test("restart recovers stale running lines and persists idle state", { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-stale-running-"));
  const routers = [];
  t.after(async () => {
    for (const router of routers.reverse()) await stopRouter(router);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const first = await startRouter(root); routers.push(first);
  const { child, base } = first;
  const created = await fetch(base + "/api/lines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "stale" }) });
  const stale = await created.json();
  const staleDir = path.join(root, stale.id);
  const persisted = JSON.parse(fs.readFileSync(path.join(staleDir, "line.json")));
  persisted.started = true; persisted.status = "running"; persisted.plannerQueue = []; persisted.activePlannerRequest = null;
  fs.writeFileSync(path.join(staleDir, "line.json"), JSON.stringify(persisted));
  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not terminate cleanly")), 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  const restarted = await startRouter(root); routers.push(restarted);
  let lines;
  for (let i = 0; i < 100; i++) {
    lines = (await (await fetch(restarted.base + "/api/lines")).json()).lines;
    if (lines.find((line) => line.id === stale.id)?.status === "idle") break;
    await wait(25);
  }
  assert.equal(lines.find((line) => line.id === stale.id).status, "idle");
  assert.equal(JSON.parse(fs.readFileSync(path.join(staleDir, "line.json"))).status, "idle");
  restarted.child.kill("SIGKILL");
  await new Promise((resolve) => restarted.child.once("exit", resolve));
  const second = await startRouter(root); routers.push(second);
  const secondLines = (await (await fetch(second.base + "/api/lines")).json()).lines;
  assert.equal(secondLines.find((line) => line.id === stale.id).status, "idle");
});

test("completed planner wait for approval publishes and persists attention", { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-attention-"));
  const bin = path.join(root, "bin"); fs.mkdirSync(bin, { recursive: true });
  const fake = path.join(bin, "vibe"); fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n"); fs.chmodSync(fake, 0o755);
  const router = await startRouter(root, { PATH: `${bin}:${process.env.PATH}` });
  t.after(async () => { await stopRouter(router); fs.rmSync(root, { recursive: true, force: true }); });
  const { base } = router;
  const created = await fetch(base + "/api/lines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "needs approval" }) });
  const line = await created.json();
  const result = await fetch(`${base}/api/lines/${line.id}/prompts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "create the plan" }) });
  assert.equal(result.status, 202);
  for (let i = 0; i < 100; i++) {
    const current = (await (await fetch(base + "/api/lines")).json()).lines.find((item) => item.id === line.id);
    if (current.status === "attention") break;
    await wait(25);
  }
  const current = (await (await fetch(base + "/api/lines")).json()).lines.find((item) => item.id === line.id);
  assert.equal(current.status, "attention");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, line.id, "line.json"))).status, "attention");
});

test("restart bootstraps every persisted pipeline graph and durable marker state", { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-graph-restart-"));
  const statuses = ["standby", "running", "attention", "failed", "idle"];
  for (const [index, status] of statuses.entries()) {
    const id = `pipeline-${index}`;
    fs.mkdirSync(path.join(root, id));
    fs.writeFileSync(path.join(root, id, "line.json"), JSON.stringify({
      id, name: id, started: status !== "standby", status,
      planApproved: status === "idle", lastError: status === "failed" ? "planner failed" : null,
      workers: [
        // A multi-megabyte aggregate snapshot reproduces the production stream
        // cutoff; small fixtures never exercised socket backpressure.
        { id: `${id}-impl`, name: "implementor", role: "implementor", status: "running", branch: "x".repeat(600_000), prompt: "Build the selected worker feature",
          harness: "pi", sessionId: `session-${id}`, worktreePath: path.join(root, id, "worker") },
        { id: `${id}-val`, name: "validator", role: "validator", validates: `${id}-impl`, status: "completed", verdict: "pass", validationCriteria: "Check the selected feature carefully" },
        { id: `${id}-integration`, name: "integration", role: "validator", kind: "integration", status: "completed", verdict: "pass" },
      ],
    }));
  }
  for (let index = 0; index < statuses.length; index++) {
    const id = `pipeline-${index}`;
    const sessions = path.join(root, id, "worker", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, `time_session-${id}.jsonl`), [
      { type: "session", id: `session-${id}` },
      { type: "message", id: "u", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "Historic user request" } },
      { type: "message", id: "a", parentId: "u", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "Historic worker answer" }] } },
    ].map(record => JSON.stringify(record)).join("\n") + "\n");
  }
  // One unreadable record must not prevent the other graphs from loading.
  fs.mkdirSync(path.join(root, "broken"));
  fs.writeFileSync(path.join(root, "broken", "line.json"), "{");
  const router = await startRouter(root);
  const { base } = router;
  t.after(async () => { await stopRouter(router); fs.rmSync(root, { recursive: true, force: true }); });
  const { request, response } = await openStream(base);
  t.after(() => request.destroy());
  let body = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("missing restart snapshot")), 5000);
    response.on("data", (chunk) => {
      body += chunk;
      if (body.includes('"type":"snapshot_end"')) { clearTimeout(timer); resolve(); }
    });
    response.on("error", reject);
  });
  assert.ok(Buffer.byteLength(body) > 1024 * 1024);
  const events = [...body.matchAll(/^data: (.*)$/gm)].map((match) => JSON.parse(match[1]));
  assert.equal(events[0].data.lines.length, statuses.length);
  const states = events.filter((event) => event.type === "state");
  assert.equal(states.length, statuses.length);
  for (const [index, event] of states.entries()) {
    const expected = statuses[index] === "running" ? "idle" : statuses[index];
    assert.equal(event.data.status, expected);
    assert.equal(event.data.attention, expected === "attention");
    assert.equal(event.data.error, expected === "failed");
    assert.equal(event.data.workers.length, 3);
    assert.equal(event.data.workers[0].status, "stopped");
    for (const worker of event.data.workers) {
      assert.equal(Object.hasOwn(worker, "prompt"), false);
      assert.equal(Object.hasOwn(worker, "criteria"), false);
      assert.ok(worker.scopeRevision);
    }
    const disk = JSON.parse(fs.readFileSync(path.join(root, event.lineId, "line.json")));
    assert.equal(disk.status, expected);
    assert.equal(disk.workers.length, 3);
  }

  const scopeUrl = `${base}/api/lines/pipeline-0/workers/pipeline-0-impl/scope`;
  const scopeResponse = await fetch(scopeUrl);
  assert.equal(scopeResponse.status, 200);
  assert.equal(scopeResponse.headers.get("cache-control"), "no-store");
  assert.equal((await scopeResponse.json()).prompt, "Build the selected worker feature");
  const validatorScope = await (await fetch(`${base}/api/lines/pipeline-0/workers/pipeline-0-val/scope`)).json();
  assert.equal(validatorScope.criteria, "Check the selected feature carefully");
  assert.equal(validatorScope.validatesName, "implementor");
  const historyResponse = await fetch(`${base}/api/lines/pipeline-0/workers/pipeline-0-impl/transcript`);
  assert.equal(historyResponse.status, 200);
  assert.equal(historyResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual((await historyResponse.json()).entries.map(e => e.text), ["Historic user request", "Historic worker answer"]);
  const unavailable = await (await fetch(`${base}/api/lines/pipeline-0/workers/pipeline-0-val/transcript`)).json();
  assert.equal(unavailable.available, false);
  assert.equal((await fetch(`${base}/api/lines/pipeline-0/workers/pipeline-1-impl/transcript`)).status, 404);
  assert.equal((await fetch(`${base}/api/lines/pipeline-0/workers/pipeline-1-impl/scope`)).status, 404);
  assert.equal((await fetch(`${base}/api/lines/missing/workers/pipeline-0-impl/scope`)).status, 404);

  // Exercise the actual page as well as the SSE payload: every pipeline must
  // render its planner, implementor, validator and integration nodes on reload.
  const { openPage } = require("./fixtures/browser-driver");
  let page;
  try { page = await openPage(base, { initScript: `
    window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };
    window.__scopeRequests = []; window.__releaseScope = {};
    const originalFetch = window.fetch.bind(window);
    window.fetch = (url, options) => {
      if (String(url).endsWith('/scope')) {
        window.__scopeRequests.push(String(url));
        return new Promise(resolve => { window.__releaseScope[String(url)] = () => resolve(originalFetch(url, options)); });
      }
      return originalFetch(url, options);
    };
  ` }); }
  catch (error) {
    if (error.code === "BROWSER_UNAVAILABLE") { t.diagnostic("Browser graph checks unavailable: " + error.message); return; }
    throw error;
  }
  try {
    await page.waitFor("document.querySelectorAll('.card .gnode.planner').length === 5 && document.querySelectorAll('.card .gnode').length >= 20");
    const markers = await page.evaluate(`Array.from(document.querySelectorAll('.card')).map(card => ({
      id: card.dataset.lineId,
      planner: card.querySelector('.gnode.planner .dot').className,
      heading: card.querySelector('.head .dot')?.className,
      nodes: card.querySelectorAll('.gnode').length,
    }))`);
    const colors = ["gray", "green", "yellow", "red", "green"];
    for (const item of markers) {
      const color = colors[Number(item.id.split("-")[1])];
      assert.equal(item.planner, `dot marker-${color}`);
      assert.equal(item.heading, item.planner);
      assert.ok(item.nodes >= 4);
    }
    assert.equal(await page.evaluate("window.__scopeRequests.length"), 0, "no eager scope fetches");
    assert.equal(page.requests().filter(url => url.includes('/workers/') && url.endsWith('/transcript')).length, 0,
      "worker histories must not be loaded before selection");
    const card = `document.querySelector('.card[data-line-id="pipeline-0"]')`;
    await page.evaluate(`${card}.querySelector('.gnode.worker:not(.w-validator)').click()`);
    await page.waitFor(`${card}.querySelector('.scopeLoading').textContent === 'Loading scope…'`);
    assert.equal(await page.evaluate(`${card}.querySelector('.scopeDetails').open`), false,
      "selecting a worker must not automatically expand scope");
    await page.evaluate(`${card}.querySelector('.scopeDetails summary').click()`);
    assert.equal(await page.evaluate(`${card}.querySelector('.scopeDetails').open`), true);
    assert.equal(await page.evaluate(`${card}.querySelector('.scopeDetails').getAttribute('aria-busy')`), "true");
    await page.evaluate(`${card}.querySelector('.gnode.worker.w-validator').click()`);
    await page.waitFor("window.__scopeRequests.length === 2");
    await page.evaluate("window.__releaseScope[window.__scopeRequests[0]]()");
    await page.waitFor("!document.querySelector('.scopeBody pre').textContent.includes('Build the selected worker feature')");
    await page.evaluate("window.__releaseScope[window.__scopeRequests[1]]()");
    await page.waitFor(`${card}.querySelector('.scopeBody pre').textContent.includes('Check the selected feature carefully')`);
    assert.equal(await page.evaluate(`${card}.querySelector('.scopeDetails').getAttribute('aria-busy')`), "false");
    assert.equal(await page.evaluate(`${card}.querySelector('.scopeLoading').hidden`), true);
    await page.evaluate(`(() => {
      const original = window.fetch;
      window.fetch = (url, options) => String(url).endsWith('/transcript')
        ? new Promise(resolve => { window.__releaseHistory = () => resolve(original(url, options)); })
        : original(url, options);
    })()`);
    await page.evaluate(`${card}.querySelector('.gnode.worker:not(.w-validator)').click()`);
    await page.waitFor(`${card}.querySelector('.scopeBody pre').textContent.includes('Build the selected worker feature')`);
    assert.equal(await page.evaluate("window.__scopeRequests.length"), 2, "reselect uses cached scope");
    await page.waitFor(`${card}.querySelector('.historyStatus')?.textContent === 'Loading chat history…'`);
    assert.equal(await page.evaluate(`${card}.querySelector('.historyStatus').getAttribute('aria-busy')`), "true");
    await page.evaluate("window.__releaseHistory()");
    await page.waitFor(`${card}.querySelector('.transcript .assistant')?.textContent.includes('Historic worker answer')`);
    assert.ok(await page.evaluate(`${card}.querySelector('.transcript .user')?.textContent.includes('Historic user request')`));
    assert.equal(await page.evaluate(`${card}.querySelector('.historyStatus')?.textContent || ''`), "");
  } finally { await page.close(); }
});

test("shared dashboard stream bootstraps and publishes line lifecycle events", { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-events-api-"));
  const router = await startRouter(root);
  const { base } = router;
  t.after(async () => {
    await stopRouter(router);
    fs.rmSync(root, { recursive: true, force: true });
  });

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

test("prompt API and dashboard SSE preserve identical queued user IDs and positions", { timeout: 30_000 }, async (t) => {
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
  const routers = [];
  t.after(async () => {
    for (const router of routers.reverse()) await stopRouter(router);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const first = await startRouter(root, { PATH: `${bin}:${process.env.PATH}` }); routers.push(first);
  const { base } = first;

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

test("DELETE queued prompt uses HTTP, authoritative SSE, persistence, conflicts, and failed-save rollback", { timeout: 30_000 }, async (t) => {
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
  const routers = [];
  t.after(async () => {
    for (const router of routers.reverse()) await stopRouter(router);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const initialRouter = await startRouter(root, { PATH: `${bin}:${process.env.PATH}` }); routers.push(initialRouter);
  const { child, base } = initialRouter;

  const stream = await openStream(base);
  t.after(() => stream.request.destroy());
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
  const restarted = await startRouter(root, { PATH: `${bin}:${process.env.PATH}` }); routers.push(restarted);
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

test("Node serves the dashboard stream over direct HTTP/2 when TLS is configured", { timeout: 30_000 }, async (t) => {
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
  const router = await startRouter(root, { HTTPS_PORT: String(httpsPort), TLS_KEY: key, TLS_CERT: cert });
  t.after(async () => { await stopRouter(router); fs.rmSync(root, { recursive: true, force: true }); });

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

test("integration request for a line deleted during body upload makes no worktree", { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-integration-delete-"));
  const routers = [];
  t.after(async () => {
    for (const router of routers.reverse()) await stopRouter(router);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const id = "line-int";
  const workdir = path.join(root, id);
  fs.mkdirSync(workdir);
  execFileSync("git", ["-C", workdir, "init", "-q"]);
  execFileSync("git", ["-C", workdir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  fs.writeFileSync(path.join(workdir, "line.json"), JSON.stringify({
    id, name: "integration", started: true, planApproved: true, status: "idle",
    workers: [{ id: "impl-1", name: "impl", role: "implementor", branch: "feature/x", status: "stopped" }],
    repos: [], inventory: [], evidence: [], pendingValidations: [],
  }));
  const router = await startRouter(root); routers.push(router);
  const payload = Buffer.from(JSON.stringify({ prompt: "integrate" }));
  const req = http.request(`${router.base}/api/protocol/lines/${id}/integration`, { method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": String(payload.length) } });
  const response = new Promise((resolve) => req.on("response", (res) => { res.resume(); resolve(res.statusCode); }));
  req.write(payload.subarray(0, 5));
  await wait(100);
  assert.equal((await fetch(`${router.base}/api/lines/${id}`, { method: "DELETE" })).status, 202);
  req.end(payload.subarray(5));
  assert.equal(await response, 404);
  assert.equal(fs.existsSync(path.join(root, "worktrees", id)), false);
});
