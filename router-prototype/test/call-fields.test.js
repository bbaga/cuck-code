"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { requiredFields, checkCall } = require("../call-fields");

const task = { description: "The task.", type: "text" };
const criteria = { description: "Criteria.", type: "text" };
const ticket = { description: "Ticket.", type: "string", pattern: "^[A-Z]+-[0-9]+$", optional: true };

function resolved(extra = {}) {
  return {
    name: "p", start: "planner", defaults: {},
    nodes: {
      planner: { type: "planner", fields: {}, checks: [] },
      A: { type: "implementor", fields: {}, checks: [] },
      B: { type: "validator", fields: {}, checks: ["A"] },
    },
    edges: [],
    types: {
      planner: { name: "planner", workspace: "coordinator", fields: {}, body: "" },
      implementor: {
        name: "implementor", workspace: "own-worktree", fields: { task, trackerTicket: ticket },
        body: "Repo {{repo.name}}.\n{{#trackerTicket}}Ticket {{trackerTicket}}{{/trackerTicket}}\n{{task}}",
      },
      validator: {
        name: "validator", workspace: "source", fields: { criteria },
        body: "Source {{source.report}}\n{{criteria}}",
      },
    },
    interactions: {
      start: { name: "start", effect: "create", trigger: "request", target: "new", fields: {}, body: "" },
      feedback: {
        name: "feedback", effect: "deliver", trigger: "request", target: "chosen",
        fields: { instructions: { description: "Follow-up.", type: "text" } }, body: "{{instructions}}",
      },
      ...(extra.interactions || {}),
    },
  };
}

test("start on an implementor needs task and repo", () => {
  const f = requiredFields(resolved(), "start", "A");
  assert.deepEqual(Object.keys(f).sort(), ["base", "name", "repo", "task", "trackerTicket"]);
  assert.equal(f.task.requiredBy, "node type implementor");
  assert.equal(f.repo.decl.type, "repo");
  assert.equal(f.base.decl.optional, true);
  assert.equal(f.name.decl.optional, true);
});

test("start on a validator needs criteria and source", () => {
  const f = requiredFields(resolved(), "start", "B");
  assert.deepEqual(Object.keys(f).sort(), ["criteria", "name", "source"]);
  assert.equal(f.source.decl.type, "instance");
  assert.equal(f.source.decl.node, "A");
  assert.equal(f.source.requiredBy, "workspace: source");
});

test("feedback needs instance and instructions", () => {
  const f = requiredFields(resolved(), "feedback", "A");
  assert.deepEqual(Object.keys(f).sort(), ["instance", "instructions"]);
  assert.equal(f.instructions.requiredBy, "interaction feedback");
  assert.equal(f.instance.decl.type, "instance");
});

test("a node prompt with {{riskLevel}} adds riskLevel", () => {
  const r = resolved();
  r.nodes.B.prompt = "Risk: {{riskLevel}}";
  r.nodes.B.fields = { riskLevel: { description: "Risk.", type: "enum", values: ["low", "high"] } };
  const f = requiredFields(r, "start", "B");
  assert.equal(f.riskLevel.requiredBy, "pipeline node B");
  const res = checkCall(r, "start", "B", { criteria: "1. x", source: "i1", riskLevel: "mid" });
  assert.equal(res.invalid[0].field, "riskLevel");
});

test("defaults prompt fields are required", () => {
  const r = resolved();
  r.defaults = { prompt: "Product {{product}}" };
  r.nodes.A.fields = { product: { description: "Product.", type: "string" } };
  assert.equal(requiredFields(r, "start", "A").product.requiredBy, "pipeline defaults");
});

test("two different declarations of one field throw", () => {
  const r = resolved();
  r.nodes.A.prompt = "{{task}}";
  r.nodes.A.fields = { task: { description: "Other.", type: "string" } };
  assert.throws(() => requiredFields(r, "start", "A"), /task/);
  const r2 = resolved({ interactions: {
    start: {
      name: "start", effect: "create", trigger: "request", target: "new",
      fields: { task: { description: "Different.", type: "text" } }, body: "{{task}}",
    },
  } });
  assert.throws(() => requiredFields(r2, "start", "A"), /different ways/);
});

test("equal declarations from two sources are merged", () => {
  const r = resolved({ interactions: {
    start: { name: "start", effect: "create", trigger: "request", target: "new", fields: { task }, body: "{{task}}" },
  } });
  assert.equal(requiredFields(r, "start", "A").task.requiredBy, "interaction start");
});

test("an undeclared caller placeholder throws", () => {
  const r = resolved();
  r.nodes.A.prompt = "{{mystery}}";
  assert.throws(() => requiredFields(r, "start", "A"), /mystery/);
});

test("checkCall: extra key and router variable are unexpected", () => {
  const res = checkCall(resolved(), "feedback", "A", { instance: "i1", instructions: "go", extra: "x", report: "r" });
  assert.equal(res.ok, false);
  assert.deepEqual(res.unexpected.sort(), ["extra", "report"]);
  assert.deepEqual(res.missing, []);
});

test("checkCall: ok, missing, expected text", () => {
  const good = checkCall(resolved(), "start", "A", { task: "do", repo: "r" });
  assert.equal(good.ok, true);
  assert.equal(good.expected.task, "text, required");
  assert.equal(good.expected.trackerTicket, "string ^[A-Z]+-[0-9]+$, optional");
  const bad = checkCall(resolved(), "start", "B", {});
  assert.deepEqual(bad.missing.map((m) => m.field).sort(), ["criteria", "source"]);
  assert.equal(bad.expected.source, "instance of A, required");
});

test("unknown interaction or node throws", () => {
  assert.throws(() => requiredFields(resolved(), "nope", "A"), /unknown interaction/);
  assert.throws(() => requiredFields(resolved(), "start", "Z"), /unknown node/);
});

test("a declared field that the body does not use is still required (accept needs a reason)", () => {
  const r = resolved({ interactions: { accept: {
    name: "accept", effect: "accept", trigger: "request", target: "chosen", body: "",
    fields: { instance: { description: "The instance.", type: "instance" }, reason: { description: "Why.", type: "string" } },
  } } });
  const need = requiredFields(r, "accept", "A");
  assert.deepEqual(Object.keys(need).sort(), ["instance", "reason"]);
  assert.equal(need.instance.decl.node, "A", "the effect declaration of 'instance' wins");
  const bad = checkCall(r, "accept", "A", { instance: "i1" });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missing.map((m) => m.field), ["reason"]);
  assert.equal(checkCall(r, "accept", "A", { instance: "i1", reason: "reviewed" }).ok, true);
});
