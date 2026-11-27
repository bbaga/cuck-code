"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadInteraction } = require("../interactions");
const { FormatError } = require("../frontmatter");

const FIELD = "  instructions:\n    description: What to do.\n    type: text\n";

function doc({ name = "demo", effect = "deliver", trigger = "request", target = "chosen", fields = FIELD, extra = "", body = "Do {{instructions}}\n" } = {}) {
  const f = fields === null ? "" : `fields:\n${fields}`;
  return `---\nname: ${name}\ndescription: A demo.\neffect: ${effect}\ntrigger: ${trigger}\ntarget: ${target}\n${extra}${f}---\n${body}`;
}

function load(text, opts, dir = "interactions/demo") {
  return loadInteraction(dir, (p) => {
    assert.equal(p, `${dir}/INTERACTION.md`);
    return text;
  }, opts);
}

function fault(text, opts, dir) {
  try { load(text, opts, dir); } catch (err) {
    assert.ok(err instanceof FormatError, String(err));
    assert.equal(err.file, `${dir || "interactions/demo"}/INTERACTION.md`);
    return err;
  }
  return assert.fail("expected an error");
}

test("good deliver interaction", () => {
  const i = load(doc());
  assert.equal(i.name, "demo");
  assert.equal(i.effect, "deliver");
  assert.equal(i.trigger, "request");
  assert.equal(i.target, "chosen");
  assert.equal(i.fields.instructions.type, "text");
  assert.equal(i.body, "Do {{instructions}}\n");
});

test("good create interaction", () => {
  const i = load(doc({ effect: "create", target: "new" }));
  assert.equal(i.effect, "create");
});

test("good accept interaction when built in", () => {
  const i = load(doc({ effect: "accept", body: "" }), { builtIn: true });
  assert.equal(i.effect, "accept");
});

test("good complete-triggered interaction with router variables only", () => {
  const i = load(doc({ trigger: "complete", target: "starter", fields: null, body: "{{from.node}}: {{report}} {{outcome}}\n" }));
  assert.equal(i.trigger, "complete");
  assert.deepEqual(i.fields, {});
});

test("unknown header key", () => {
  assert.match(fault(doc({ extra: "color: red\n" })).message, /color/);
});

test("bad values for effect, trigger and target", () => {
  assert.match(fault(doc({ effect: "send" })).message, /effect/);
  assert.match(fault(doc({ trigger: "now" })).message, /trigger/);
  assert.match(fault(doc({ target: "all" })).message, /target/);
});

test("missing effect", () => {
  const text = doc().replace("effect: deliver\n", "");
  assert.match(fault(text).message, /effect/);
});

test("name must equal the folder name", () => {
  assert.match(fault(doc({ name: "other" })).message, /name/);
});

test("bad effect and target pairs", () => {
  assert.match(fault(doc({ effect: "create", target: "chosen" })).message, /create.*new/);
  assert.match(fault(doc({ effect: "deliver", target: "new" })).message, /deliver/);
  assert.match(fault(doc({ effect: "accept", target: "starter", body: "" }), { builtIn: true }).message, /accept/);
});

test("target chosen needs trigger request", () => {
  const err = fault(doc({ trigger: "complete", target: "chosen", fields: null, body: "{{report}}" }));
  assert.match(err.message, /chosen/);
});

test("a plugin cannot use accept", () => {
  assert.match(fault(doc({ effect: "accept", body: "" })).message, /built-in/);
  assert.match(fault(doc({ effect: "accept", body: "" }), { builtIn: false }).message, /built-in/);
});

test("accept needs an empty body", () => {
  assert.match(fault(doc({ effect: "accept", body: "text\n" }), { builtIn: true }).message, /empty/);
});

test("bad field declaration", () => {
  const bad = "  instructions:\n    description: x\n    type: blob\n";
  assert.match(fault(doc({ fields: bad })).message, /type must be one of/);
});

test("template error reports the real file line", () => {
  const err = fault(doc({ body: "line\n{{#open}}\n" }));
  assert.equal(err.line, 13); // body starts on line 12, the open tag is body line 2
  assert.match(err.message, /not closed/);
});

test("complete trigger: caller variable is rejected", () => {
  const err = fault(doc({ trigger: "complete", target: "starter", fields: null, body: "{{report}} {{extra}}" }));
  assert.match(err.message, /a complete-triggered interaction has no caller: use router variables only/);
});

test("complete trigger: fields must be empty", () => {
  const err = fault(doc({ trigger: "complete", target: "starter", body: "{{report}}" }));
  assert.match(err.message, /a complete-triggered interaction has no caller: use router variables only/);
});

test("request trigger: undeclared placeholder", () => {
  const err = fault(doc({ body: "{{instructions}} {{other}}" }));
  assert.match(err.message, /declare field `other` in INTERACTION.md fields/);
});

test("request trigger: router variables need no declaration", () => {
  load(doc({ body: "{{from.node}} {{instructions}}" }));
});

test("request trigger: optional field outside its section", () => {
  const opt = FIELD + "  note:\n    description: A note.\n    type: string\n    optional: true\n";
  assert.match(fault(doc({ fields: opt, body: "{{instructions}} {{note}}" })).message, /optional field 'note'/);
  load(doc({ fields: opt, body: "{{instructions}} {{#if note}}{{note}}{{/if}}" }));
});

test("missing file and bad frontmatter", () => {
  assert.throws(() => loadInteraction("d/x", () => { throw new Error("nope"); }), /INTERACTION.md/);
  assert.match(fault("no header").message, /---/);
});

// ---- when, fallback, arrive, waiter ----

const COMPLETE = { trigger: "complete", target: "starter", fields: null, body: "{{report}}" };
const ALL_OUTCOMES = ["done", "pass", "reject", "missing", "timeout", "failed", "stopped"];

test("when defaults to all seven outcomes and fallback to false", () => {
  const i = load(doc(COMPLETE));
  assert.deepEqual(i.when, ALL_OUTCOMES);
  assert.equal(i.fallback, false);
  assert.deepEqual(load(doc()).when, ALL_OUTCOMES);
});

test("when and fallback are read from a complete-triggered interaction", () => {
  const i = load(doc({ ...COMPLETE, extra: "when: [reject]\nfallback: true\n" }));
  assert.deepEqual(i.when, ["reject"]);
  assert.equal(i.fallback, true);
});

test("when and fallback are refused on a request interaction", () => {
  assert.match(fault(doc({ extra: "when: [done]\n" })).message, /when is allowed only with trigger complete/);
  assert.match(fault(doc({ extra: "fallback: true\n" })).message, /fallback is allowed only with trigger complete/);
});

test("when refuses an unknown outcome, an empty list and a duplicate", () => {
  for (const when of ["[done, late]", "[]", "[done, done]", "done"]) {
    assert.match(fault(doc({ ...COMPLETE, extra: `when: ${when}\n` })).message, /when must be a non-empty list/, when);
  }
});

test("fallback must be a boolean", () => {
  assert.match(fault(doc({ ...COMPLETE, extra: "fallback: yes please\n" })).message, /fallback must be true or false/);
});

const ARRIVE = { effect: "arrive", trigger: "complete", target: "waiter", fields: null, body: "" };

test("effect arrive loads for a built-in interaction", () => {
  const i = load(doc(ARRIVE), { builtIn: true });
  assert.equal(i.effect, "arrive");
  assert.equal(i.target, "waiter");
});

test("effect arrive is reserved for built-in interactions", () => {
  assert.match(fault(doc(ARRIVE)).message, /effect arrive is reserved for built-in interactions/);
});

test("effect arrive needs trigger complete, target waiter and an empty body", () => {
  assert.match(fault(doc({ ...ARRIVE, trigger: "request" }), { builtIn: true }).message, /needs trigger complete and target waiter/);
  assert.match(fault(doc({ ...ARRIVE, target: "starter" }), { builtIn: true }).message, /needs trigger complete and target waiter/);
  assert.match(fault(doc({ ...ARRIVE, body: "text" }), { builtIn: true }).message, /arrive interaction must have an empty body/);
});

test("target waiter needs effect arrive", () => {
  assert.match(fault(doc({ ...COMPLETE, target: "waiter", effect: "deliver" }), { builtIn: true }).message, /target waiter needs effect arrive/);
  assert.match(fault(doc({ effect: "create", trigger: "complete", target: "waiter", fields: null, body: "" }), { builtIn: true }).message, /target waiter needs effect arrive/);
});

test("effect create with trigger complete stays legal in the loader", () => {
  const i = load(doc({ effect: "create", trigger: "complete", target: "new", fields: null, body: "" }));
  assert.equal(i.effect, "create");
});
