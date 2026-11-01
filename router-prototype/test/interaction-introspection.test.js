"use strict";

// GET /api/protocol/lines/:id/interactions through a real router.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startRouter, stopRouter } = require("./fixtures/router-process");

let root, router, base;
const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => null) };
};

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "introspection-"));
  const linesDir = path.join(root, "lines");
  fs.mkdirSync(path.join(linesDir, "l1"), { recursive: true });
  fs.writeFileSync(path.join(linesDir, "l1", "line.json"), JSON.stringify({
    id: "l1", name: "l1", layout: 2, started: true, planApproved: true, repos: [], workers: [] }));
  router = await startRouter(linesDir, {});
  base = router.base;
});

test.after(async () => {
  if (router) await stopRouter(router);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an unknown line is 404", async () => {
  assert.equal((await get("/api/protocol/lines/nope/interactions")).status, 404);
});

test("the default graph lists start, feedback and accept with their fields", async () => {
  const out = await get("/api/protocol/lines/l1/interactions");
  assert.equal(out.status, 200);
  assert.equal(out.body.caller, "planner");
  assert.deepEqual(out.body.interactions.map((i) => i.name), ["start", "feedback", "accept"]);
  const by = Object.fromEntries(out.body.interactions.map((i) => [i.name, i]));
  assert.equal(by.start.effect, "create");
  assert.equal(by.start.target, "new");
  assert.deepEqual(by.start.to.map((t) => t.node),
    ["backend-impl", "frontend-impl", "backend-val", "frontend-val", "integration"]);
  assert.deepEqual(by.feedback.to.map((t) => t.node), ["backend-impl", "frontend-impl"]);
  assert.deepEqual(by.accept.to.map((t) => t.node), ["backend-impl", "frontend-impl"]);
  const fieldsOf = (i, node) => by[i].to.find((t) => t.node === node).fields;
  const val = fieldsOf("start", "backend-val");
  assert.ok(val.criteria && val.source);
  assert.equal(val.source.expected, "instance of backend-impl, required");
  assert.ok(val.source.description);
  assert.ok(fieldsOf("start", "backend-impl").repo);
  assert.ok(fieldsOf("start", "backend-impl").task);
  assert.deepEqual(Object.keys(fieldsOf("feedback", "backend-impl")).sort(), ["instance", "instructions"]);
  assert.deepEqual(Object.keys(fieldsOf("accept", "frontend-impl")).sort(), ["instance", "reason"]);
});
