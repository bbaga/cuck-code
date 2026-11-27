"use strict";

// The runtime of handoff, rework and stages in the router (chain-runtime.js), in one process.
// Fake child processes stand for the agents. The planner never starts: its request stays queued.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createFakeChild } = require("./fixtures/planner-child");
const { loadBuiltinPipeline } = require("../line-graph");
const { resolve } = require("./choreo-fixtures");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "choreo-runtime-"));
process.env.LINES_DIR = root;
const server = require("../server");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (cwd, ...args) => execFileSync("git",
  ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
const ROOT = path.join(__dirname, "..");
const CHOREOGRAPHED = () => loadBuiltinPipeline("choreographed", fs, ROOT);
// A pipeline text with the check nodes and edges given. The head node "impl" and the planner stay.
const pipeline = (checks, edges) => resolve(`name: choreographed
start: planner
nodes:
  planner: { type: planner }
  impl: { type: backend-implementor }
${checks}
  integration: { type: integration-validator }
edges:
  - planner -> impl: start, feedback, accept
  - impl -> planner: report
${edges}
  - planner -> integration: start
  - integration -> planner: report
`);
// Two validators in one stage; no wait node.
const FAN_OUT = () => pipeline("  val: { type: backend-validator, checks: [impl] }\n  lint: { type: backend-validator, checks: [impl] }",
  `  - "impl -> [val, lint]: handoff"
  - "[val, lint] -> impl: rework"
  - "[val, lint] -> planner: report"`);
const SCRIPT = () => pipeline(
  '  lint: { type: script-check, checks: [impl], scripts: [{ name: env, run: "printf %s \\"$DUCK_BASE_COMMIT\\"" }] }',
  "  - impl -> lint: handoff\n  - lint -> planner: report");

let seq = 0;
function repo(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  const base = git(dir, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "work.js"), "// work\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "work");
  return { dir, base };
}

// A line with a chain head "impl" and fake processes. Texts for the planner collect in item.queue.
function rig(graph, { headFields = {} } = {}) {
  const id = `rig-${++seq}`;
  const workdir = path.join(root, id);
  fs.mkdirSync(workdir);
  const wt = repo(`${id}-wt`);
  const item = { id, name: id, workdir, status: "running", activePlannerRequest: { id: "busy", text: "busy" },
    deleted: false, compacting: false, started: true, planApproved: true, queue: [], transcript: [],
    workers: new Map(), clients: new Set(), inventory: new Map(), repos: new Map(), pendingValidations: [],
    sessionId: null, sessionCfg: null, context: null, nodeSettings: {}, graph, pendingHandoffs: [] };
  const head = { id: `${id}-h`, name: "impl", role: "implementor", node: "impl", persona: "backend",
    kind: "standard", repo: "api", branch: "b/impl", harness: "vibe", status: "running", stopRequested: false,
    baseCommit: wt.base, worktreePath: wt.dir, prompt: "Work.", transcript: [], sessionId: null,
    runGeneration: 1, chainFields: { criteria: "Check the work.", ...headFields }, reworkRounds: {}, stage: null };
  item.workers.set(head.id, head);
  const spawned = [];
  server.setSpawnForTest((cmd, args) => {
    const child = createFakeChild();
    spawned.push({ child, args: JSON.stringify(args), ended: false });
    return child;
  });
  const endNext = (text) => {
    const next = spawned.find((s) => !s.ended);
    next.ended = true;
    next.child.stdout.write(JSON.stringify({ type: "message", role: "assistant", sessionId: "s-1",
      content: [{ type: "text", text }] }) + "\n");
    next.child.emitClose(0);
  };
  const texts = () => item.queue.map((r) => r.text);
  const running = () => spawned.filter((s) => !s.ended).length;
  const runHead = () => { server.spawnWorker(item, head, "Work.", false); endNext("Did the work."); };
  return { item, head, spawned, endNext, texts, running, runHead, wt };
}

const PASS = "Checked.\nVERDICT: PASS";
const FAIL = "Found a problem.\nVERDICT: FAIL";

test("impl done: the router starts the validator with the criteria; the planner gets no wake", () => {
  const r = rig(CHOREOGRAPHED());
  r.runHead();
  assert.equal(r.running(), 1, "one validator runs");
  assert.deepEqual(r.texts(), []);
  const val = [...r.item.workers.values()].find((w) => w.role === "validator");
  assert.equal(val.validates, r.head.id);
  assert.equal(r.head.stage.members.val.status, "running");
  assert.equal(r.head.stage.headRun, 1);
  assert.match(val.prompt, /Check the work\./);
});

test("validator FAIL resumes impl with the rework text; the planner gets no wake", () => {
  const r = rig(CHOREOGRAPHED());
  r.runHead();
  r.endNext(FAIL);
  assert.deepEqual(r.texts(), []);
  assert.equal(r.running(), 1, "the implementor runs again");
  assert.match(r.spawned[2].args, /REWORK REQUEST/);
  assert.equal(r.head.runGeneration, 2);
  assert.deepEqual(r.head.reworkRounds, { impl: 1 });
  assert.equal(r.head.stage, null);
});

test("after maxRounds reworks the next FAIL gives REWORK LIMIT REACHED and the report", () => {
  const r = rig(CHOREOGRAPHED());
  r.runHead();
  for (let round = 1; round <= 3; round++) {
    r.endNext(FAIL);
    assert.deepEqual(r.texts(), [], `rework ${round} wakes nobody`);
    r.endNext("Fixed it.");
  }
  r.endNext(FAIL);
  assert.equal(r.texts().length, 1);
  assert.match(r.texts()[0], /^REWORK LIMIT REACHED/);
  assert.match(r.texts()[0], /VALIDATION REPORT/);
  assert.equal(r.running(), 0, "no rework starts");
  assert.equal(r.head.reworkRounds.impl, 3);
});

test("PASS at the chain end gives one VALIDATION REPORT with PASS", () => {
  const r = rig(CHOREOGRAPHED());
  r.runHead();
  r.endNext(FAIL);
  r.endNext("Fixed it.");
  r.endNext(PASS);
  assert.equal(r.texts().length, 1);
  assert.match(r.texts()[0], /^VALIDATION REPORT/);
  assert.match(r.texts()[0], /FINAL VERDICT: PASS/);
});

test("a full worker cap queues the handoff and a freed slot starts it", () => {
  const r = rig(CHOREOGRAPHED());
  for (let i = 0; i < 8; i++) {
    r.item.workers.set(`busy-${i}`, { id: `busy-${i}`, name: `busy-${i}`, role: "implementor", status: "running" });
  }
  r.runHead();
  assert.deepEqual(r.item.pendingHandoffs, [{ to: "val", headId: r.head.id, headRun: 1 }]);
  assert.equal(r.head.stage.members.val.status, "queued");
  assert.deepEqual(r.texts(), []);
  assert.equal(r.running(), 0);
  r.item.workers.get("busy-0").status = "completed";
  server.drainPendingHandoffs(r.item);
  assert.deepEqual(r.item.pendingHandoffs, []);
  assert.equal(r.running(), 1, "the validator starts");
  assert.equal(r.head.stage.members.val.status, "running");
});

test("a pending handoff of an older head run is dropped", () => {
  const r = rig(CHOREOGRAPHED());
  r.item.pendingHandoffs.push({ to: "val", headId: r.head.id, headRun: 1 });
  r.head.runGeneration = 2;
  server.drainPendingHandoffs(r.item);
  assert.deepEqual(r.item.pendingHandoffs, []);
  assert.equal(r.running(), 0);
});

test("an implementor run with a blocked change set starts no checker", () => {
  const r = rig(CHOREOGRAPHED());
  fs.writeFileSync(path.join(r.wt.dir, "untracked.txt"), "x\n");
  r.runHead();
  assert.equal(r.texts().length, 1, "only the change set wake");
  assert.match(r.texts()[0], /^CHANGESET BLOCKED/);
  assert.equal(r.head.stage, null);
  assert.equal(r.running(), 0);
});

test("a handoff that cannot start sends HANDOFF FAILED and the report", () => {
  // "gate" is a check that the planner starts; no run of it passed, so val may not start.
  const graph = pipeline(`  gate: { type: script-check, checks: [impl], scripts: [{ name: ok, run: "true" }] }
  val: { type: backend-validator, checks: [impl], after: [gate] }`,
  `  - planner -> gate: start
  - gate -> planner: report
  - impl -> val: handoff
  - val -> impl: rework
  - val -> planner: report`);
  const r = rig(graph);
  r.runHead();
  assert.equal(r.texts().length, 1);
  assert.match(r.texts()[0], /^HANDOFF FAILED - val could not start for 'impl': AFTER_NOT_PASSED/);
  assert.match(r.texts()[0], /IMPLEMENTOR REPORT/);
  assert.equal(r.head.stage, null);
});

test("a fan-out stage: one combined rework after both checkers ended", () => {
  const r = rig(FAN_OUT());
  r.runHead();
  assert.equal(r.running(), 2, "both checkers start on one run");
  r.endNext(PASS);
  assert.deepEqual(r.texts(), []);
  assert.equal(r.running(), 1, "no rework before the last checker ends");
  r.endNext(FAIL);
  assert.deepEqual(r.texts(), []);
  assert.match(r.spawned[3].args, /REWORK REQUEST - 1 of 2 checkers rejected/);
  assert.deepEqual(r.head.reworkRounds, { impl: 1 });
});

test("a fan-out stage: both PASS give one planner report after the second ends", () => {
  const r = rig(FAN_OUT());
  r.runHead();
  r.endNext(PASS);
  assert.deepEqual(r.texts(), []);
  r.endNext(PASS);
  assert.equal(r.texts().length, 1);
  assert.match(r.texts()[0], /^STAGE REPORT/);
  assert.equal(r.head.stage, null);
});

test("a fan-out result of an older head run is ignored", () => {
  const r = rig(FAN_OUT());
  r.runHead();
  r.endNext(PASS);
  r.head.runGeneration = 2;
  r.endNext(FAIL);
  assert.deepEqual(r.texts(), []);
  assert.equal(r.running(), 0, "no rework starts");
  assert.deepEqual(r.head.reworkRounds, {});
});

test("DUCK_BASE_COMMIT reaches the script environment", async () => {
  const graph = SCRIPT();
  const r = rig(graph);
  r.runHead();
  const check = [...r.item.workers.values()].find((w) => w.runner === "script");
  for (let i = 0; i < 200 && check.status === "running"; i++) await new Promise((ok) => setTimeout(ok, 25));
  assert.equal(check.status, "completed");
  assert.equal(fs.readFileSync(check.checkResults[0].logFile, "utf8").trim(), r.wt.base);
});

// HTTP calls into the same process.
async function withHttp(fn) {
  const srv = server.createServer();
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  try {
    await fn(async (line, name, body) => {
      const data = JSON.stringify(body);
      return new Promise((ok, fail) => {
        const req = http.request({ host: "127.0.0.1", port: srv.address().port, method: "POST",
          path: `/api/protocol/lines/${line}/interactions/${name}`, headers: { "Content-Type": "application/json" } },
        (res) => { let text = ""; res.on("data", (c) => { text += c; }); res.on("end", () => ok({ status: res.statusCode, text })); });
        req.on("error", fail);
        req.end(data);
      });
    });
  } finally {
    await new Promise((ok) => srv.close(ok));
  }
}

test("start stores the chain fields on the head; feedback resets rounds and stage", async () => {
  const r = rig(CHOREOGRAPHED());
  server.lines.set(r.item.id, r.item);
  r.item.repos.set("api", { name: "api", url: r.wt.dir, path: r.wt.dir });
  await withHttp(async (post) => {
    const started = await post(r.item.id, "start", { to: "impl", task: "Build it.", criteria: "Be right.",
      repo: "api", name: "chain-head" });
    assert.equal(started.status, 201, started.text);
    const head = [...r.item.workers.values()].find((w) => w.name === "chain-head");
    assert.deepEqual(head.chainFields, { criteria: "Be right." });
    assert.deepEqual(head.reworkRounds, {});
    assert.equal(head.stage, null);

    head.status = "completed";
    head.child = null;
    head.sessionId = "s-1";
    head.reworkRounds = { impl: 2 };
    head.stage = { sender: "impl", headRun: 1, members: { val: { status: "running", checkerId: "x", outcome: null } } };
    const fed = await post(r.item.id, "feedback", { instance: head.id, instructions: "Do more." });
    assert.equal(fed.status, 202, fed.text);
    assert.deepEqual(head.reworkRounds, {});
    assert.equal(head.stage, null);
  });
});

test("a validator that stopped without a verdict reports to the planner and uses no rework round", () => {
  const r = rig(CHOREOGRAPHED());
  r.runHead();
  r.endNext("Polling CI... 14 of 22 jobs queued");
  assert.equal(r.running(), 0);
  assert.deepEqual(r.head.reworkRounds, {});
  assert.equal(r.head.stage, null);
  assert.equal(r.texts().length, 1);
  assert.match(r.texts()[0], /VALIDATION REPORT/);
  assert.match(r.texts()[0], /DIAGNOSTIC/);
});

test("a fan-out FAIL with a missing verdict reworks with the FAIL report only", () => {
  const r = rig(FAN_OUT());
  r.runHead();
  r.endNext(FAIL);
  r.endNext("no verdict text");
  assert.deepEqual(r.texts(), []);
  assert.equal(r.head.reworkRounds.impl, 1);
  assert.match(r.spawned[3].args, /REWORK REQUEST/);
  assert.match(r.spawned[3].args, /Found a problem\./);
});

test("a fan-out PASS with a missing verdict gives one planner report and no rework", () => {
  const r = rig(FAN_OUT());
  r.runHead();
  r.endNext(PASS);
  r.endNext("no verdict text");
  assert.equal(r.running(), 0);
  assert.equal(r.texts().length, 1);
  assert.deepEqual(r.head.reworkRounds, {});
});
