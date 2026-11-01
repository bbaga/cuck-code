"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const page = require("../web/pipelines-page");

function fakeClock() {
  let now = 0; const timers = [];
  return {
    setTimeout(fn, ms) { const t = { fn, at: now + ms, id: timers.length + 1 }; timers.push(t); return t.id; },
    clearTimeout(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    advance(ms) { now += ms; for (const t of [...timers]) if (t.at <= now) { timers.splice(timers.indexOf(t), 1); t.fn(); } },
    pending: () => timers.length,
  };
}

test("debouncer fires once, 400 ms after the last call", () => {
  const clock = fakeClock(); const calls = [];
  const d = page.createDebouncer(clock, 400);
  d.call(() => calls.push("a"));
  clock.advance(300);
  d.call(() => calls.push("b"));
  clock.advance(300);
  assert.deepEqual(calls, []);
  clock.advance(100);
  assert.deepEqual(calls, ["b"]);
  d.call(() => calls.push("c")); d.cancel();
  clock.advance(1000);
  assert.deepEqual(calls, ["b"]);
  assert.equal(clock.pending(), 0);
  assert.equal(page.VALIDATE_DELAY_MS, 400);
});

test("save state from errors, dirty flag and pending work", () => {
  assert.equal(page.saveState({ errors: [], dirty: true }).disabled, false);
  assert.equal(page.saveState({ errors: [], dirty: false }).disabled, true);
  assert.match(page.saveState({ errors: [], dirty: false }).reason, /no changes/i);
  const bad = page.saveState({ errors: [{ rule: "X", message: "m" }], dirty: true });
  assert.equal(bad.disabled, true);
  assert.match(bad.reason, /error/i);
  assert.equal(page.saveState({ errors: [], dirty: true, validating: true }).disabled, true);
  assert.equal(page.saveState({ errors: [], dirty: true, saving: true }).disabled, true);
  assert.equal(page.saveState({ errors: null, dirty: true }).disabled, true);
});

test("error lines read rule: message", () => {
  assert.deepEqual(page.errorLines([{ rule: "LOAD", message: "bad" }, { rule: "NAME", message: "x" }]), ["LOAD: bad", "NAME: x"]);
  assert.deepEqual(page.errorLines(null), []);
});

test("grouping and sorting of the list", () => {
  const groups = page.groupItems({
    pipelines: [
      { name: "zeta", layer: "built-in", editable: false, problems: [] },
      { name: "beta", layer: "managed", editable: true, problems: [{ rule: "R", message: "m" }] },
      { name: "alpha", layer: "managed", editable: true, problems: [] },
      { name: "mid", layer: "user", editable: false, problems: [] }],
    nodeTypes: [{ name: "planner", layer: "built-in" }],
    interactions: [{ name: "start", layer: "built-in" }, { name: "accept", layer: "user" }],
  });
  assert.deepEqual(groups.map((g) => g.key), ["pipelines", "nodeTypes", "interactions"]);
  assert.deepEqual(groups.map((g) => g.title), ["Pipelines", "Node types", "Interactions"]);
  assert.deepEqual(groups[0].items.map((i) => i.name), ["alpha", "beta", "mid", "zeta"]);
  assert.equal(groups[0].items[1].warn, true);
  assert.equal(groups[0].items[0].warn, false);
  assert.equal(groups[0].items[0].kind, "pipeline");
  assert.equal(groups[1].items[0].kind, "node-types");
  assert.equal(groups[2].items[0].kind, "interactions");
  assert.deepEqual(groups[2].items.map((i) => i.name), ["accept", "start"]);
  assert.deepEqual(page.groupItems({}).map((g) => g.items.length), [0, 0, 0]);
});

test("toolbar state", () => {
  assert.deepEqual(page.toolbarState({ kind: "pipeline", editable: false }), { editor: false, duplicate: true, save: false, delete: false });
  assert.deepEqual(page.toolbarState({ kind: "pipeline", editable: true }), { editor: true, duplicate: true, save: true, delete: true });
  assert.deepEqual(page.toolbarState({ kind: "node-types", editable: false }), { editor: false, duplicate: false, save: false, delete: false });
  assert.deepEqual(page.toolbarState({ kind: "interactions", editable: true }), { editor: false, duplicate: false, save: false, delete: false });
  assert.deepEqual(page.toolbarState(null), { editor: false, duplicate: false, save: false, delete: false });
});

test("graph for the layout: nodes by id, kinds on every edge", () => {
  const g = page.layoutInput({
    start: "a", kinds: { start: { effect: "create", trigger: "request" } },
    nodes: [{ id: "a", type: "t", phase: "planner" }, { id: "b", type: "t", phase: null }],
    edges: [{ from: "a", to: "b", interactions: ["start", "other"] }],
  });
  assert.deepEqual(Object.keys(g.nodes), ["a", "b"]);
  assert.equal(g.start, "a");
  assert.deepEqual(g.edges[0].kinds.start, { effect: "create", trigger: "request" });
  assert.equal(g.edges[0].kinds.other, undefined);
  const noKinds = page.layoutInput({ nodes: [{ id: "x", type: "t" }], edges: [] });
  assert.equal(noKinds.start, "x");
  assert.equal(page.layoutInput(null), null);
});

test("name check matches the server rule", () => {
  assert.equal(page.nameProblem("my-copy"), null);
  for (const bad of ["", "A", "-a", "a b", "../x", "x".repeat(61)]) assert.ok(page.nameProblem(bad), bad);
});
