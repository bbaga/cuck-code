"use strict";
const test = require("node:test");
const assert = require("node:assert");
const R = require("../web/registry-ui.js");

const claim = {
  id: "c1", title: "Add X", status: "stale", staleReason: "owner deleted",
  ownerLineName: "Line A", ownerLineId: "l1", ownerExists: false, repo: "r", branch: "b",
  commit: "0123456789abcdef", revision: 7, updatedAt: "2026-01-01T00:00:00Z", unverified: true,
  mergeCheck: { verified: false, reason: "no-pr", checkedAt: "2026-01-02" },
};

test("claimRow builds the view model", () => {
  const r = R.claimRow(claim);
  assert.strictEqual(r.commit, "01234567");
  assert.strictEqual(r.owner, "Line A (deleted owner)");
  assert.strictEqual(r.revision, "7");
  assert.strictEqual(r.mergeCheck, "unverified: no-pr");
  assert.deepStrictEqual(r.badges, ["stale: owner deleted", "unverified"]);
  assert.strictEqual(R.claimRow({ id: "x", revision: 0 }).revision, "0");
  assert.strictEqual(R.mergeCheckLabel({ verified: true, checkedAt: "t" }), "verified");
});

test("archiveRow renders evidence as text", () => {
  const r = R.archiveRow({ id: "a", title: "T", mergedAt: "m", mergeEvidence: {
    repositoryUrl: "u", targetBranch: "main", commit: "abcdef123456", strategy: "squash",
    pullRequest: { number: 5 }, checkedAt: "c" } });
  assert.deepStrictEqual([r.repository, r.targetBranch, r.strategy, r.pullRequest, r.commit, r.checkedAt],
    ["u", "main", "squash", "#5", "abcdef12", "c"]);
  for (const v of Object.values(r)) assert.ok(!String(v).includes("[object"));
  assert.strictEqual(R.archiveRow({ mergeEvidence: { pullRequest: 9 } }).pullRequest, "#9");
});

test("status filter maps to query", () => {
  const u = (filter, q) => R.listUrl("claims", { filter, q, page: 2, pageSize: 10 });
  assert.strictEqual(u("current"), "/api/registry/claims?page=2&pageSize=10");
  assert.strictEqual(u("all", " foo "), "/api/registry/claims?status=all&q=foo&page=2&pageSize=10");
  assert.ok(u("stale").includes("status=stale"));
  assert.ok(!u("bogus").includes("status="));
  assert.strictEqual(R.FILTERS.length, 8);
  assert.ok(!R.STATUSES.includes("unverified") && R.STATUSES.includes("superseded"));
  assert.ok(R.listUrl("archive", { filter: "stale", page: 1 }).startsWith("/api/registry/archive?page=1"));
});

test("paging label", () => {
  assert.strictEqual(R.pagingLabel({ page: 2, pageSize: 25, total: 51 }), "page 2 of 3 (51 total)");
  assert.strictEqual(R.pagingLabel({ page: 1, pageSize: 25, total: 0 }), "page 1 of 1 (0 total)");
});

test("refetch only for a higher revision", () => {
  assert.ok(R.shouldRefetch(3, 4));
  assert.ok(!R.shouldRefetch(4, 4));
  assert.ok(!R.shouldRefetch(5, 4));
  assert.ok(R.shouldRefetch(null, 1));
  assert.ok(!R.shouldRefetch(1, undefined));
});

test("connection transitions", () => {
  const c = R.createConnection();
  assert.strictEqual(c.state.label, "offline");
  assert.strictEqual(c.onOpen().label, "live");
  assert.strictEqual(c.onError().label, "reconnecting");
  c.onError();
  const s = c.onError();
  assert.strictEqual(s.label, "offline");
  assert.ok(s.polling);
  assert.strictEqual(c.onOpen().label, "live");
  assert.ok(!c.state.polling);
  assert.ok(R.createConnection().onUnavailable().polling);
});

test("toggle saves and restores line view", () => {
  const view = { selected: "L1", visible: true };
  const log = [];
  const t = R.createToggle(() => { view.visible = false; }, () => { view.visible = true; },
    () => log.push("open"), () => log.push("close"));
  t.show(); t.show();
  assert.ok(!view.visible);
  t.hide(); t.hide();
  assert.ok(view.visible);
  assert.strictEqual(view.selected, "L1");
  assert.deepStrictEqual(log, ["open", "close"]);
  t.toggle();
  assert.ok(t.open);
});

function fakeDoc() {
  const mk = (tag) => ({ tag, children: [], listeners: {}, textContent: "", attrs: {},
    append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; },
    addEventListener(e, f) { this.listeners[e] = f; }, setAttribute(k, v) { this.attrs[k] = v; } });
  return { createElement: mk, mk };
}
const flush = () => new Promise((r) => setImmediate(r));

test("mount loads data, shows errors, and handles stream events", async () => {
  const doc = fakeDoc();
  const calls = [];
  let fail = false;
  const fetchFn = async (u) => {
    calls.push(u);
    if (fail) return { ok: false, status: 503, json: async () => ({ error: "Work registry is corrupt", code: "REGISTRY_UNAVAILABLE", file: "f" }) };
    return { ok: true, json: async () => u.includes("summary")
      ? { claimsByStatus: { active: 2 }, archiveCount: 1, snapshotRevision: 5 }
      : { items: [claim], page: 1, pageSize: 25, total: 1, hasMore: false, snapshotRevision: 5 } };
  };
  const timers = [];
  const win = { setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout() {},
    setInterval: () => 1, clearInterval() {} };
  let es;
  class FakeES { constructor(u) { this.u = u; this.l = {}; es = this; }
    addEventListener(e, f) { this.l[e] = f; } close() { this.closed = true; } }
  const container = doc.mk("section");
  const v = R.mount(doc, container, { fetch: fetchFn, window: win, EventSource: FakeES });
  v.start();
  await flush();
  assert.strictEqual(es.u, "/api/registry/stream");
  assert.strictEqual(v.state.revision, 5);
  const [summaryBar, errLine] = container.children.slice(1);
  assert.ok(summaryBar.textContent.includes("active: 2"));
  assert.ok(summaryBar.textContent.includes("revision: 5"));
  const n = calls.length;
  es.l.registry({ data: JSON.stringify({ revision: 5 }) });
  assert.strictEqual(timers.length, 0);
  es.l.registry({ data: JSON.stringify({ revision: 6 }) });
  assert.strictEqual(timers.length, 1);
  fail = true;
  timers[0]();
  await flush();
  assert.ok(calls.length > n);
  assert.match(errLine.textContent, /REGISTRY_UNAVAILABLE: Work registry is corrupt/);
  assert.strictEqual(v.state.result, null);
  assert.strictEqual(container.children[5].children[0].textContent, "Could not load claims");
  fail = false;
  await v.load();
  assert.strictEqual(container.children[5].children[0].tag, "table");
  v.stop();
  assert.ok(es.closed);
});

test("mount shows 400 and non-JSON errors", async () => {
  const doc = fakeDoc();
  let res;
  const win = { setTimeout() {}, clearTimeout() {}, setInterval: () => 1, clearInterval() {} };
  const container = doc.mk("section");
  const v = R.mount(doc, container, { fetch: async () => res, window: win });
  res = { ok: false, status: 400, json: async () => ({ error: "Unknown status", code: "BAD_REQUEST" }) };
  await v.load();
  assert.match(container.children[2].textContent, /BAD_REQUEST: Unknown status/);
  res = { ok: false, status: 502, json: async () => { throw new Error("x"); } };
  await v.load();
  assert.match(container.children[2].textContent, /HTTP 502/);
});
