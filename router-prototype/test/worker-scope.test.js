"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createScopeLoader, mergeHistoryEntries } = require("../web/worker-scope");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const ok = (data) => ({ ok: true, json: async () => data });

test("transcript loads use separate planner and worker URLs and merge racing live messages", async () => {
  const urls = [];
  const loader = createScopeLoader({ lineId: "line", resource: "transcript",
    fetchImpl: async url => { urls.push(url); return ok({ entries: [] }); } });
  loader.read({ id: null });
  loader.read({ id: "worker" });
  await tick();
  assert.deepEqual(urls, ["/api/lines/line/transcript", "/api/lines/line/workers/worker/transcript"]);
  const old = { role: "user", text: "Earlier", at: 1, entryId: "old" };
  const shared = { role: "assistant", text: "Answer", at: 2, entryId: "shared" };
  const racing = { role: "assistant", text: "While loading", at: 3, entryId: "racing" };
  assert.deepEqual(mergeHistoryEntries([old, shared], [shared, racing]), [old, shared, racing]);
  loader.clear();
});

test("scope loading is lazy, deduplicated, cached and invalidated by revision", async () => {
  const requests = [];
  let changes = 0;
  const loader = createScopeLoader({ lineId: "line", onChange: () => changes++,
    fetchImpl: async (url) => { requests.push(url); return ok({ prompt: "Build it" }); } });
  const worker = { id: "worker", scopeRevision: "v1" };
  assert.equal(requests.length, 0);
  const entry = loader.read(worker);
  assert.equal(entry.state, "loading");
  assert.equal(loader.read(worker), entry);
  await tick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0], "/api/lines/line/workers/worker/scope");
  assert.equal(entry.state, "loaded");
  assert.equal(entry.data.prompt, "Build it");
  assert.equal(loader.read(worker), entry);
  assert.equal(changes, 1);
  assert.equal(loader.read({ ...worker, scopeRevision: "v2" }).state, "loading");
  await tick();
  assert.equal(requests.length, 2);
  loader.clear();
});

test("failed scope requests show an error and can retry on selection", async () => {
  let calls = 0;
  const loader = createScopeLoader({ lineId: "l", fetchImpl: async () => {
    if (++calls === 1) return { ok: false, status: 404 };
    return ok({ criteria: "Check it" });
  } });
  const worker = { id: "w", scopeRevision: "v1" };
  const entry = loader.read(worker);
  await tick();
  assert.equal(entry.state, "error");
  loader.read(worker);
  assert.equal(calls, 1, "rendering must not cause a retry loop");
  loader.retry(worker.id);
  const retried = loader.read(worker);
  assert.equal(retried.state, "loading");
  await tick();
  assert.equal(retried.state, "loaded");
  assert.equal(calls, 2);
  loader.clear();
});

test("stale responses cannot overwrite newer revisions or removed workers", async () => {
  const pending = [];
  let changes = 0;
  const loader = createScopeLoader({ lineId: "l", onChange: () => changes++,
    fetchImpl: (_url, options) => new Promise((resolve) => pending.push({ resolve, signal: options.signal })) });
  loader.read({ id: "a", scopeRevision: "old" });
  await tick();
  const fresh = loader.read({ id: "a", scopeRevision: "new" });
  const other = loader.read({ id: "b", scopeRevision: "v1" });
  await tick();
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(ok({ prompt: "Old prompt" }));
  pending[1].resolve(ok({ prompt: "Current prompt" }));
  await tick();
  assert.equal(changes, 1);
  assert.equal(fresh.data.prompt, "Current prompt");
  loader.retain(new Set(["a"]));
  assert.equal(pending[2].signal.aborted, true);
  pending[2].resolve(ok({ prompt: "Removed" }));
  await tick();
  assert.equal(other.state, "loading");
  assert.equal(changes, 1);
  loader.clear();
});
