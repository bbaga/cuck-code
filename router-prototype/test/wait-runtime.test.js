"use strict";

// The runtime of the wait node in one process (wait-runtime.js, chain-runtime.js).
// Fake child processes stand for the agents. The planner never starts: its request stays queued.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createFakeChild } = require("./fixtures/planner-child");
const { CHAIN, STAGE, resolve } = require("./choreo-fixtures");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wait-runtime-"));
// The repositories stay outside LINES_DIR: loadLines would read them as lines.
const reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wait-runtime-repos-"));
process.env.LINES_DIR = root;
const server = require("../server");
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(reposRoot, { recursive: true, force: true });
});

const git = (cwd, ...args) => execFileSync("git",
  ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
const PASS = "Checked.\nVERDICT: PASS";

// A fake clock and fake timers for the wait runtime: the time limit tests do not depend on real time.
// Call the returned function (t.after) to put the real clock back.
const clock = { now: 1_000_000, timers: [] };
function useFakeTime() {
  const timing = server.waitRuntime.timing;
  const saved = { ...timing };
  clock.timers = [];
  timing.now = () => clock.now;
  timing.setTimer = (fn, ms) => { clock.timers.push({ fn, ms, cleared: false }); return clock.timers.length - 1; };
  timing.clearTimer = (id) => { if (clock.timers[id]) clock.timers[id].cleared = true; };
  return () => Object.assign(timing, saved);
}
const fire = (timer) => { if (!timer.cleared) timer.fn(); };
const INSTRUCTIONS = "Merge the batch and run the full suite.";

let seq = 0;
// A line with the chain heads `names`, all on one registered repo. Texts for the planner collect in item.queue.
function rig(names = ["ha", "hb"], graph = resolve(CHAIN)) {
  const id = `wait-${++seq}`;
  const dir = path.join(reposRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  const base = git(dir, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "work.js"), "// work\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "work");
  const workdir = path.join(root, id);
  fs.mkdirSync(workdir);
  const item = { id, name: id, workdir, status: "running", activePlannerRequest: { id: "busy", text: "busy" },
    deleted: false, compacting: false, started: true, planApproved: true, queue: [], transcript: [],
    workers: new Map(), clients: new Set(), inventory: new Map(), repos: new Map([["api", { name: "api", url: dir, path: dir }]]),
    pendingValidations: [], sessionId: null, sessionCfg: null, context: null, nodeSettings: {},
    graph, pendingHandoffs: [] };
  const heads = {};
  for (const name of names) {
    git(dir, "branch", `b/${name}`);
    heads[name] = { id: `${id}-${name}`, name, role: "implementor", node: "impl", persona: "backend",
      kind: "standard", repo: "api", branch: `b/${name}`, harness: "vibe", status: "running", stopRequested: false,
      baseCommit: base, worktreePath: dir, prompt: "Work.", transcript: [], sessionId: null, runGeneration: 1,
      chainFields: { criteria: "Check the work." }, reworkRounds: {}, stage: null };
    item.workers.set(heads[name].id, heads[name]);
  }
  server.lines.set(id, item);
  const spawned = [];
  server.setSpawnForTest(() => {
    const child = createFakeChild();
    spawned.push({ child, ended: false });
    return child;
  });
  const endNext = (text) => {
    const next = spawned.find((s) => !s.ended);
    next.ended = true;
    next.child.stdout.write(JSON.stringify({ type: "message", role: "assistant", sessionId: "s-1",
      content: [{ type: "text", text }] }) + "\n");
    next.child.emitClose(0);
  };
  // The head runs and ends, then its validator ends with PASS: the chain of the head arrives.
  const passChain = (head) => { server.spawnWorker(item, head, "Work.", false); endNext("Did the work."); endNext(PASS); };
  const waits = () => [...item.workers.values()].filter((w) => w.runner === "wait");
  const post = (name, body) => call("POST", `/api/protocol/lines/${id}/interactions/${name}`, body);
  return { item, heads, spawned, endNext, passChain, waits, post, texts: () => item.queue.map((r) => r.text) };
}

async function call(method, urlPath, body) {
  const srv = server.createServer();
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  try {
    return await new Promise((ok, fail) => {
      const req = http.request({ host: "127.0.0.1", port: srv.address().port, method, path: urlPath,
        headers: { "Content-Type": "application/json" } },
      (res) => { let text = ""; res.on("data", (c) => { text += c; });
        res.on("end", () => ok({ status: res.statusCode, text, json: text ? JSON.parse(text) : null })); });
      req.on("error", fail);
      req.end(JSON.stringify(body || {}));
    });
  } finally {
    await new Promise((ok) => srv.close(ok));
  }
}

test("two heads pass: no per-task wake, the batch completes, integration starts with the batch instructions", async () => {
  const r = rig();
  const started = await r.post("start", { to: "batch", members: "ha,hb", instructions: INSTRUCTIONS });
  assert.equal(started.status, 201, started.text);
  const [wait] = r.waits();
  assert.equal(wait.status, "running");
  r.passChain(r.heads.ha);
  assert.deepEqual(r.texts(), [], "no wake for the PASS of one task");
  assert.equal(wait.status, "running");
  r.passChain(r.heads.hb);
  assert.deepEqual(r.texts(), [], "no wake for the PASS of the last task, and no BATCH REPORT after a good handoff");
  assert.equal(wait.status, "completed");
  assert.equal(wait.verdict, "pass");
  assert.match(wait.lastRunText, /^BATCH REPORT - wait node 'batch' instance 'batch-1': all 2 members passed\./);
  const integrations = [...r.item.workers.values()].filter((w) => w.kind === "integration");
  assert.equal(integrations.length, 1, "integration starts one time");
  assert.match(integrations[0].prompt, new RegExp(INSTRUCTIONS));
});

test("feedback to an arrived head makes its arrival stale; the batch waits for the new run", async () => {
  const r = rig();
  await r.post("start", { to: "batch", members: "ha,hb", instructions: INSTRUCTIONS });
  const [wait] = r.waits();
  r.passChain(r.heads.ha);
  const fed = await r.post("feedback", { instance: r.heads.ha.id, instructions: "Change it." });
  assert.equal(fed.status, 202, fed.text);
  assert.equal(wait.arrivals[r.heads.ha.id].runGeneration, 1, "the old arrival stays");
  assert.equal(server.dashboardStateForLine(r.item).workers.find((w) => w.id === wait.id)
    .members.find((m) => m.name === "ha").state, "stale");
  // The new run of ha passes its checker: the arrival is valid again, but hb has not arrived.
  r.endNext("Changed it.");
  r.endNext(PASS);
  assert.equal(wait.arrivals[r.heads.ha.id].runGeneration, 2);
  assert.equal(wait.status, "running");
  r.passChain(r.heads.hb);
  assert.equal(wait.status, "completed");
});

test("a head that arrived before the wait instance gives the fallback report; a later batch imports it", async () => {
  const r = rig();
  r.passChain(r.heads.ha);
  assert.equal(r.texts().length, 1);
  assert.match(r.texts()[0], /VALIDATION REPORT/);
  assert.equal(r.heads.ha.pendingArrival.node, "batch");
  await r.post("start", { to: "batch", members: "ha,hb", instructions: INSTRUCTIONS });
  const [wait] = r.waits();
  assert.equal(wait.arrivals[r.heads.ha.id].runGeneration, 1);
  assert.equal(r.heads.ha.pendingArrival, null);
  assert.equal(r.texts().length, 1, "the batch start sends nothing");
});

test("a member of another running wait instance of the same node gives 409 MEMBER_IN_BATCH", async () => {
  const r = rig();
  assert.equal((await r.post("start", { to: "batch", members: "ha", instructions: INSTRUCTIONS })).status, 201);
  const second = await r.post("start", { to: "batch", members: "ha,hb", instructions: INSTRUCTIONS });
  assert.equal(second.status, 409, second.text);
  assert.equal(second.json.code, "MEMBER_IN_BATCH");
  assert.match(second.json.error, /'ha'.*'batch-1'/);
  assert.equal(r.waits().length, 1);
});

test("a name and an id of one worker in members count as a duplicate", async () => {
  const r = rig();
  const out = await r.post("start", { to: "batch", members: `ha,${r.heads.ha.id}`, instructions: INSTRUCTIONS });
  assert.equal(out.status, 400, out.text);
  assert.match(JSON.stringify(out.json.invalid), /listed twice/);
  assert.equal(r.waits().length, 0);
});

test("the time limit gives one planner wake with the missing members; no limit sets no timer", async (t) => {
  t.after(useFakeTime());
  const r = rig();
  r.item.nodeSettings = { batch: { timeLimit: 60 } };
  await r.post("start", { to: "batch", members: "ha,hb", instructions: INSTRUCTIONS });
  const [wait] = r.waits();
  assert.equal(server.waitRuntime.hasTimer(wait.id), true);
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0].ms, 60_000, "the whole limit remains at the start");
  assert.equal(wait.status, "running");
  assert.deepEqual(r.texts(), []);
  fire(clock.timers[0]);
  assert.equal(wait.status, "failed");
  assert.equal(wait.outcome, "timeout");
  assert.equal(server.waitRuntime.hasTimer(wait.id), false);
  assert.equal(r.texts().length, 1);
  assert.match(r.texts()[0], /time limit reached\. 2 of 2 members did not arrive\./);
  const none = rig();
  await none.post("start", { to: "batch", members: "ha", instructions: INSTRUCTIONS });
  assert.equal(server.waitRuntime.hasTimer(none.waits()[0].id), false);
  assert.equal(clock.timers.length, 1, "no new timer");
});

test("stop gives one planner wake with the missing members", async () => {
  const r = rig();
  await r.post("start", { to: "batch", members: "ha,hb", instructions: INSTRUCTIONS });
  const [wait] = r.waits();
  r.passChain(r.heads.ha);
  const stopped = await call("POST", `/api/protocol/workers/${wait.id}/stop`);
  assert.equal(stopped.status, 202);
  assert.equal(wait.status, "stopped");
  assert.equal(wait.outcome, "stopped");
  assert.equal(r.texts().length, 1);
  assert.match(r.texts()[0], /: stopped\. 1 of 2 members did not arrive\./);
  const removed = await call("POST", `/api/protocol/workers/${wait.id}/remove`);
  assert.equal(removed.status, 200, "a finished wait worker can be removed");
});

// Saves the line and writes a new start time of the wait worker into line.json.
function saveWithStart(item, wait, startedAtMs) {
  item.activePlannerRequest = null;
  server.saveLine(item);
  const file = path.join(item.workdir, "line.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved.workers.find((w) => w.id === wait.id).startedAt = new Date(startedAtMs).toISOString();
  fs.writeFileSync(file, JSON.stringify(saved));
  server.lines.delete(item.id);
}

test("a running wait worker with arrivals survives a save and a load with the rest of its time", async (t) => {
  t.after(useFakeTime());
  const r = rig();
  r.item.nodeSettings = { batch: { timeLimit: 100 } };
  await r.post("start", { to: "batch", members: "ha,hb", instructions: INSTRUCTIONS });
  const [wait] = r.waits();
  r.passChain(r.heads.ha);
  // The saved start time is 99.9 s ago: 0.1 s of the limit remain.
  saveWithStart(r.item, wait, clock.now - 99_900);
  clock.timers = [];
  server.loadLines();
  const loaded = server.lines.get(r.item.id);
  // The planner stays busy, so the report stays in the queue.
  loaded.activePlannerRequest = { id: "busy", text: "busy" };
  loaded.status = "running";
  const again = loaded.workers.get(wait.id);
  assert.equal(again.status, "running");
  assert.equal(again.runner, "wait");
  assert.deepEqual(again.members, wait.members);
  assert.equal(again.arrivals[r.heads.ha.id].runGeneration, 1);
  assert.deepEqual(again.chainFields, { instructions: INSTRUCTIONS });
  assert.equal(server.waitRuntime.hasTimer(again.id), true);
  const timer = clock.timers.find((x) => x.ms === 100);
  assert.ok(timer, "the timer has the rest of the time");
  fire(timer);
  assert.equal(again.status, "failed", "the rest of the time ran out");
  assert.equal(loaded.queue.length, 1);
});

test("a time limit that is over at load time applies at once: one wake, no timer", async (t) => {
  t.after(useFakeTime());
  const r = rig();
  r.item.nodeSettings = { batch: { timeLimit: 100 } };
  await r.post("start", { to: "batch", members: "ha,hb", instructions: INSTRUCTIONS });
  const [wait] = r.waits();
  r.passChain(r.heads.ha);
  saveWithStart(r.item, wait, clock.now - 200_000);
  // The load pumps the planner queue at once: record the wake requests that the pump sees.
  const wakes = new Set();
  server.setLifecycleHooksForTest({ pump: (line) => {
    if (line.id === r.item.id) line.queue.filter((q) => /^BATCH REPORT/.test(q.text)).forEach((q) => wakes.add(q.id));
  } });
  t.after(() => server.setLifecycleHooksForTest(null));
  server.loadLines();
  const again = server.lines.get(r.item.id).workers.get(wait.id);
  assert.equal(again.status, "failed");
  assert.equal(again.outcome, "timeout");
  assert.equal(server.waitRuntime.hasTimer(again.id), false);
  assert.equal(wakes.size, 1, "the planner gets exactly one wake");
  assert.match(again.lastRunText, /time limit reached\. 1 of 2 members did not arrive\./);
  assert.match(again.lastRunText, /hb.*waiting/);
});

test("a wait worker does not count against the worker cap", async () => {
  const r = rig();
  for (let i = 0; i < 8; i++) {
    r.item.workers.set(`filler-${i}`, { id: `filler-${i}`, name: `filler-${i}`, role: "implementor", node: "impl",
      status: "running", runner: "agent", transcript: [] });
  }
  const out = await r.post("start", { to: "batch", members: "ha,hb", instructions: INSTRUCTIONS });
  assert.equal(out.status, 201, out.text);
});

test("the dashboard state has the members, the rework state and the wait_update event", async () => {
  const r = rig();
  const events = [];
  r.item.clients.add({ write: (chunk) => events.push(chunk) });
  await r.post("start", { to: "batch", members: "ha,hb", instructions: INSTRUCTIONS });
  const [wait] = r.waits();
  assert.ok(events.some((e) => e.startsWith("event: worker_spawned")));
  r.heads.ha.reworkRounds = { impl: 1 };
  r.passChain(r.heads.ha);
  const update = events.filter((e) => e.startsWith("event: wait_update")).pop();
  assert.ok(update, "an arrival sends wait_update");
  const payload = JSON.parse(update.split("data: ")[1]);
  assert.equal(payload.workerId, wait.id);
  assert.deepEqual(payload.members.map((m) => m.state), ["arrived", "waiting"]);
  const state = server.dashboardStateForLine(r.item);
  const view = state.workers.find((w) => w.id === wait.id);
  assert.equal(view.runner, "wait");
  assert.deepEqual(view.members.map((m) => m.name), ["ha", "hb"]);
  const head = state.workers.find((w) => w.id === r.heads.ha.id);
  assert.deepEqual(head.reworkRounds, { impl: 1 });
  assert.deepEqual(head.maxRounds, { impl: 3 });
  assert.equal(head.stage, null);
  r.heads.hb.stage = { sender: "impl", headRun: 1, members: { val: { status: "running", checkerId: "c", outcome: null } } };
  const running = server.dashboardStateForLine(r.item).workers.find((w) => w.id === r.heads.hb.id);
  assert.deepEqual(running.stage, { sender: "impl", members: [{ node: "val", status: "running", outcome: null, checkerId: "c" }] });
});

test("each change of the stage sends worker_status with the current chain fields of the head", () => {
  const graph = resolve(STAGE.replace(/lint: \{ type: script-check.*\n/,
    "lint: { type: backend-validator, checks: [impl], maxRounds: 3 }\n"));
  const r = rig(["ha"], graph);
  const events = [];
  r.item.clients.add({ write: (chunk) => events.push(chunk) });
  // The chain events of the head: worker_status events that carry the chain fields.
  const chainEvents = () => events.filter((e) => e.startsWith("event: worker_status"))
    .map((e) => JSON.parse(e.split("data: ")[1]))
    .filter((p) => p.workerId === r.heads.ha.id && p.worker && p.worker.stage !== undefined);
  const statuses = (p) => p.worker.stage.members.map((m) => m.status).sort();
  server.spawnWorker(r.item, r.heads.ha, "Work.", false);
  r.endNext("Did the work.");
  const started = chainEvents();
  assert.deepEqual(statuses(started.find((p) => p.worker.stage)), ["queued", "queued"], "the stage start");
  assert.deepEqual(statuses(started.at(-1)), ["running", "running"], "both members run");
  r.endNext(PASS);
  assert.deepEqual(statuses(chainEvents().at(-1)), ["done", "running"], "the first member ended");
  r.endNext("Found a problem.\nVERDICT: FAIL");
  const last = chainEvents().at(-1);
  assert.equal(last.worker.stage, null, "the stage ended");
  assert.deepEqual(last.worker.reworkRounds, { impl: 1 }, "one combined rework");
  assert.deepEqual(last.worker.maxRounds, { impl: 3 });
  assert.deepEqual(r.heads.ha.reworkRounds, { impl: 1 });
});
