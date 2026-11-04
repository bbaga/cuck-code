"use strict";
// Unit tests for the scripted pi detail stub: run its page script in a small
// node:vm sandbox with a fake previous fetch and prove routing, call
// accounting, held versus immediate responses, error bodies, and non-pi
// pass-through. No browser and no application code involved.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const H = require("./fixtures/settings-roundtrip-helpers");

const PI_URL = "http://127.0.0.1/api/harnesses/pi?provider=openai-codex";
const OTHER_URL = "http://127.0.0.1/api/lines";

// Run one scriptedPi script in a sandbox whose window carries a recording
// previous fetch. The script only needs the globals listed here.
function runScriptedPi(calls) {
  const realCalls = [];
  const window = {
    fetch: (url, opts) => {
      realCalls.push({ url: String(url), opts });
      return Promise.resolve(new Response("passthrough"));
    },
    __piFetches: [],
  };
  const sandbox = { window, Response, JSON, Math, Promise, String, setTimeout };
  vm.createContext(sandbox);
  vm.runInContext(H.scriptedPi(calls), sandbox, { timeout: 1000 });
  return { window, realCalls };
}

test("scripted pi stub routes provider calls and records them", async () => {
  const models = [{ value: "openai-codex/gpt-5.2", label: "gpt-5.2" }];
  const { window } = runScriptedPi([{ models }]);
  const res = await window.fetch(PI_URL);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: "pi", authMode: "openai-codex", auth: "ok", models });
  assert.deepEqual(window.__piFetches, [PI_URL]);
  assert.equal(window.__piCalls, 1);
});

test("scripted pi stub passes non-pi calls through to the previous fetch", async () => {
  const { window, realCalls } = runScriptedPi([]);
  const res = await window.fetch(OTHER_URL, { method: "GET" });
  assert.equal(await res.text(), "passthrough");
  assert.deepEqual(realCalls, [{ url: OTHER_URL, opts: { method: "GET" } }]);
  assert.deepEqual(window.__piFetches, []);
  assert.equal(window.__piCalls, 0);
});

test("scripted pi stub serves each call in order and repeats the last one", async () => {
  const { window } = runScriptedPi([
    { models: [{ value: "openai-codex/a", label: "a" }] },
    { models: [{ value: "openai-codex/b", label: "b" }] },
  ]);
  assert.equal(JSON.parse(await (await window.fetch(PI_URL)).text()).models[0].value,
    "openai-codex/a");
  assert.equal(JSON.parse(await (await window.fetch(PI_URL)).text()).models[0].value,
    "openai-codex/b");
  // A third call repeats the last answer; the accounting counts every call.
  assert.equal(JSON.parse(await (await window.fetch(PI_URL)).text()).models[0].value,
    "openai-codex/b");
  assert.equal(window.__piCalls, 3);
  assert.equal(window.__piFetches.length, 3);
});

test("scripted pi stub honors an immediate error status and body", async () => {
  const { window } = runScriptedPi([
    { status: 500, body: JSON.stringify({ error: "pi detail exploded" }) },
  ]);
  const res = await window.fetch(PI_URL);
  assert.equal(res.status, 500);
  assert.equal(res.ok, false);
  assert.deepEqual(await res.json(), { error: "pi detail exploded" });
});

test("scripted pi stub holds a response until its release handle fires", async () => {
  const models = [{ value: "openai-codex/held", label: "held" }];
  const { window } = runScriptedPi([{ hold: true, models }]);
  const pending = window.fetch(PI_URL);
  assert.equal(window.__releases.length, 1);
  // The response stays in flight until the release: a microtask tick cannot
  // settle it, and no body is readable yet.
  let settled = false;
  pending.then(() => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  window.__releases[0]();
  const res = await pending;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: "pi", authMode: "openai-codex", auth: "ok", models });
  assert.equal(settled, true);
});

test("scripted pi stub keeps a held call pending across a newer immediate call", async () => {
  const { window } = runScriptedPi([
    { hold: true, models: [{ value: "openai-codex/old", label: "old" }] },
    { models: [{ value: "openai-codex/new", label: "new" }] },
  ]);
  const held = window.fetch(PI_URL);
  const immediate = await window.fetch(PI_URL);
  assert.equal(JSON.parse(await immediate.text()).models[0].value, "openai-codex/new");
  // The held call is still pending and releases independently.
  let settled = false;
  held.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  window.__releases[0]();
  assert.equal(JSON.parse(await (await held).text()).models[0].value, "openai-codex/old");
});
