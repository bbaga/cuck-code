"use strict";

// D7: a plugin pipeline end to end through a real router. The plugin folder
// (test/fixtures/plugins) is copied to a temp CUCK_HOME. Every harness binary
// is a fake script: it logs its arguments, prints the text of the file named
// by FAKE_FINAL as its final message, and exits 0.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startRouter, stopRouter, wait } = require("./fixtures/router-process");
const { buildCatalog } = require("../plugin-catalog");
const { resolvePipelineDefinition } = require("../resolve-pipeline");

const ROUTER_DIR = path.join(__dirname, "..");
const PLUGINS = path.join(__dirname, "fixtures", "plugins");

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
  { encoding: "utf8" }).trim();

async function call(base, method, pathname, body) {
  const res = await fetch(base + pathname, { method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// The fake agent. For claude it prints stream-json; for the others, vibe lines.
const FAKE = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v") || args.includes("--help")) { console.log("1.0.0"); process.exit(0); }
fs.appendFileSync(process.env.FAKE_LOG, "ARGV " + path.basename(process.argv[1]) + "\\n" + args.join(" ") + "\\n----\\n");
let text = "Done.";
try { text = fs.readFileSync(process.env.FAKE_FINAL, "utf8"); } catch {}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (path.basename(process.argv[1]) === "claude") {
  out({ type: "system", subtype: "init", session_id: "fake-session", tools: [], cwd: process.cwd(), model: "m" });
  out({ type: "assistant", session_id: "fake-session",
    message: { id: "m1", type: "message", role: "assistant", content: [{ type: "text", text }] } });
  out({ type: "result", subtype: "success", session_id: "fake-session", is_error: false, result: text });
} else {
  out({ type: "message", role: "assistant", content: [{ type: "text", text }], sessionId: "fake-session" });
}
process.exit(0);
`;

let root, router, base, src, lineId, logFile, finalFile;
const post = (name, body) => call(base, "POST", `/api/protocol/lines/${lineId}/interactions/${name}`, body);
const setFinal = (text) => fs.writeFileSync(finalFile, text);
const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "");
const lineJson = () => JSON.parse(fs.readFileSync(path.join(root, "lines", lineId, "line.json"), "utf8"));

async function until(fn, what, tries = 150) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await wait(100);
  }
  throw new Error(`timeout waiting for ${what}`);
}
const workerDone = (id) => until(() => {
  const w = lineJson().workers.find((x) => x.id === id);
  return w && w.status === "completed" ? w : null;
}, `instance ${id} to complete`);

let aId, bId, aName;

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-e2e-"));
  const linesDir = path.join(root, "lines");
  fs.mkdirSync(linesDir);
  src = path.join(root, "src", "api");
  fs.mkdirSync(src, { recursive: true });
  git(src, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(src, "a.txt"), "a");
  git(src, "add", ".");
  git(src, "commit", "-qm", "init");
  // The plugin folder is copied so the repository stays clean.
  const cuckHome = path.join(root, "cuck-home");
  fs.cpSync(PLUGINS, cuckHome, { recursive: true });
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  for (const agent of ["claude", "vibe", "codex", "pi"]) {
    fs.writeFileSync(path.join(bin, agent), FAKE);
    fs.chmodSync(path.join(bin, agent), 0o755);
  }
  logFile = path.join(root, "agent-args.log");
  finalFile = path.join(root, "final.txt");
  setFinal("Done.");
  router = await startRouter(linesDir, { ROUTER_ALLOW_LOCAL_REPOS: "1", CUCK_HOME: cuckHome,
    FAKE_LOG: logFile, FAKE_FINAL: finalFile, PATH: `${bin}:${process.env.PATH}` });
  base = router.base;
});

test.after(async () => {
  if (router) await stopRouter(router);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the review-gate pipeline resolves against the built-in files and the plugin folder", () => {
  const catalog = buildCatalog({ userDir: PLUGINS, builtInDir: ROUTER_DIR });
  assert.deepEqual(catalog.problems, []);
  const resolved = resolvePipelineDefinition("review-gate", catalog);
  assert.equal(resolved.nodes.B.type, "security-reviewer");
  assert.deepEqual(resolved.nodes.B.checks, ["A"]);
  assert.deepEqual(Object.keys(resolved.nodes.B.fields), ["riskLevel"]);
});

test("a line on review-gate is created, gets the first prompt, and the plan is approved", async () => {
  const created = await call(base, "POST", "/api/lines", { name: "gate", pipelineName: "review-gate",
    repos: [{ name: "api", url: src }] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  lineId = created.body.id;
  const prompt = await call(base, "POST", `/api/lines/${lineId}/prompts`, { text: "Build the thing." });
  assert.equal(prompt.status, 202, JSON.stringify(prompt.body));
  await until(() => readLog().includes("Build the thing."), "the first planner run");
  const approved = await call(base, "POST", `/api/lines/${lineId}/approve`);
  assert.equal(approved.status, 202, JSON.stringify(approved.body));
});

test("the planner prompt lists calls only for the interactions and nodes that have edges", () => {
  const first = readLog().split("----\n")[0];
  assert.match(first, /## Calls/);
  assert.match(first, /### start: node 'A'/);
  assert.match(first, /### start: node 'B'/);
  assert.match(first, /### feedback: node 'A'/);
  assert.match(first, /### accept: node 'A'/);
  assert.match(first, /"riskLevel"/);
  assert.ok(!/### feedback: node 'B'/.test(first), "no feedback call for B");
  assert.ok(!/### accept: node 'B'/.test(first), "no accept call for B");
  assert.ok(!/integration/.test(first.slice(first.indexOf("## Calls"))), "no call for integration");
  assert.ok(!/### start: node 'planner'/.test(first));
});

test("1. start on A without repo is 400 and lists task and repo", async () => {
  const out = await post("start", { to: "A" });
  assert.equal(out.status, 400, JSON.stringify(out.body));
  assert.equal(out.body.code, "INTERACTION_FIELDS");
  assert.deepEqual(out.body.missing.map((m) => m.field).sort(), ["repo", "task"]);
  const partial = await post("start", { to: "A", task: "t" });
  assert.equal(partial.status, 400);
  assert.deepEqual(partial.body.missing.map((m) => m.field), ["repo"]);
});

test("2. start on A with all fields is 201", async () => {
  setFinal("Implemented it. Files changed: a.txt.");
  const out = await post("start", { to: "A", task: "Add a feature.", repo: "api", name: "impl-a" });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  aId = out.body.instance.workerId;
  aName = "impl-a";
  assert.ok(aId);
});

test("3. when A finishes, the planner receives the report of A", async () => {
  await workerDone(aId);
  await until(() => /IMPLEMENTOR REPORT - 'impl-a'/.test(readLog()), "the report of A in a planner run");
  const log = readLog();
  assert.match(log, /Implemented it\. Files changed: a\.txt\./);
  assert.match(log, new RegExp(`workerId ${aId}`));
});

test("4. start on B without riskLevel is 400 with riskLevel and its description", async () => {
  const out = await post("start", { to: "B", criteria: "1. No secrets in code.", source: aId });
  assert.equal(out.status, 400, JSON.stringify(out.body));
  assert.equal(out.body.code, "INTERACTION_FIELDS");
  assert.deepEqual(out.body.missing.map((m) => m.field), ["riskLevel"]);
  assert.equal(out.body.missing[0].description, "The risk level of the change, from the planner's assessment.");
  const bad = await post("start", { to: "B", criteria: "1. x", source: aId, riskLevel: "extreme" });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.invalid.map((m) => m.field), ["riskLevel"]);
});

test("5. start on B with all fields is 201 and B ends with VERDICT: FAIL", async () => {
  setFinal("1. No secrets in code: FAIL, a token is logged.\nVERDICT: FAIL");
  const out = await post("start", { to: "B", criteria: "1. No secrets in code.", source: aId, riskLevel: "high" });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  bId = out.body.instance.validatorId;
  assert.ok(bId);
  const w = await workerDone(bId);
  assert.equal(w.node, "B");
  assert.equal(w.validates, aId);
  assert.match(w.lastRunText, /VERDICT: FAIL\s*$/);
  assert.equal(w.verdict, "fail");
  // Regression: a field declared under the node's `fields` reaches the prompt
  // (the router used to pass only `criteria` and `trackerTicket`, so the start
  // failed with 500 PROMPT_BUILD 'Missing value "riskLevel"').
  await until(() => /risk level of this change is high/.test(readLog()), "the B prompt in the log");
});

test("6. the planner receives a report with the reject outcome", async () => {
  await until(() => readLog().includes("FINAL VERDICT: FAIL"), "the reject report in a planner run");
  const log = readLog();
  const report = log.slice(log.indexOf("FINAL VERDICT: FAIL") - 600);
  assert.match(report, /VALIDATION REPORT/);
  assert.match(report, /FINAL VERDICT: FAIL/);
});

test("7. feedback to the A instance is 202", async () => {
  setFinal("Fixed it.");
  const out = await post("feedback", { instance: aId, instructions: "Remove the token from the log." });
  assert.equal(out.status, 202, JSON.stringify(out.body));
  await workerDone(aId);
});

test("8. feedback to the B instance is 403 NO_EDGE", async () => {
  const out = await post("feedback", { instance: bId, instructions: "x" });
  assert.equal(out.status, 403, JSON.stringify(out.body));
  assert.equal(out.body.code, "NO_EDGE");
});
