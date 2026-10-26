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

const okRes = (u, rev = 5) => ({ ok: true, json: async () => (u.includes("summary")
  ? { claimsByStatus: { active: 2 }, archiveCount: 1, snapshotRevision: rev }
  : { items: [claim], page: 1, pageSize: 25, total: 1, hasMore: false }) });
const errRes = (status, error, code) => ({ ok: false, status, json: async () => (error ? { error, code } : Promise.reject(new Error("x"))) });
function env(respond, EventSource) {
  ES.all = [];
  const e = { calls: [], timers: [], polling: 0, c: fakeDoc().mk("section") };
  e.win = { setTimeout: (f) => e.timers.push(f), clearTimeout() {},
    setInterval: (f) => { e.poll = f; e.polling += 1; return 1; }, clearInterval() { e.polling -= 1; } };
  e.v = R.mount(fakeDoc(), e.c, { fetch: async (u) => { e.calls.push(u); return respond(u); }, window: e.win, EventSource });
  e.wrap = () => e.c.children[5].children[0];
  e.err = () => e.c.children[2].textContent;
  e.conn = () => e.c.children[4].children[2].textContent;
  return e;
}
class ES {
  static all = [];
  constructor(u) { this.u = u; this.l = {}; ES.all.push(this); }
  addEventListener(e, f) { this.l[e] = f; }
  close() { this.closed = true; }
}

test("mount loads data, shows errors, and handles stream events", async () => {
  let res = okRes;
  const e = env((u) => res(u), ES);
  e.v.start();
  await flush();
  const es = ES.all[0];
  assert.strictEqual(es.u, "/api/registry/stream");
  assert.strictEqual(e.v.state.revision, 5);
  assert.match(e.c.children[1].textContent, /active: 2.*revision: 5/);
  const n = e.calls.length;
  es.l.registry({ data: JSON.stringify({ revision: 5 }) });
  assert.strictEqual(e.timers.length, 0);
  es.l.registry({ data: JSON.stringify({ revision: 6 }) });
  assert.strictEqual(e.timers.length, 1);
  res = () => errRes(503, "Work registry is corrupt", "REGISTRY_UNAVAILABLE");
  e.timers[0]();
  await flush();
  assert.ok(e.calls.length > n);
  assert.match(e.err(), /REGISTRY_UNAVAILABLE: Work registry is corrupt/);
  assert.strictEqual(e.v.state.result, null);
  assert.strictEqual(e.wrap().textContent, "Could not load claims");
  res = okRes;
  await e.v.load();
  assert.strictEqual(e.wrap().tag, "table");
  e.v.stop();
  assert.ok(es.closed);
});

test("mount shows 400 and non-JSON errors", async () => {
  let res = errRes(400, "Unknown status", "BAD_REQUEST");
  const e = env(() => res);
  await e.v.load();
  assert.match(e.err(), /BAD_REQUEST: Unknown status/);
  res = errRes(502);
  await e.v.load();
  assert.match(e.err(), /HTTP 502/);
});

test("polling failure clears rows and a later poll restores them", async () => {
  let res = okRes;
  const e = env((u) => res(u));
  e.v.start();
  await flush();
  assert.strictEqual(e.wrap().tag, "table");
  res = () => { throw new Error("network down"); };
  await e.poll();
  assert.strictEqual(e.wrap().textContent, "Could not load claims");
  assert.match(e.err(), /network down/);
  res = okRes;
  await e.poll();
  assert.strictEqual(e.wrap().tag, "table");
  assert.strictEqual(e.err(), "");
  res = () => errRes(503, "corrupt", "REGISTRY_UNAVAILABLE");
  await e.poll();
  assert.strictEqual(e.wrap().textContent, "Could not load claims");
  assert.match(e.err(), /REGISTRY_UNAVAILABLE: corrupt/);
});

test("closed stream starts polling and a good poll reopens it", async () => {
  let res = () => errRes(503, "corrupt", "REGISTRY_UNAVAILABLE");
  const e = env((u) => res(u), ES);
  e.v.start();
  ES.all[0].readyState = 2;
  ES.all[0].onerror();
  await flush();
  assert.strictEqual(e.polling, 1);
  assert.match(e.err(), /REGISTRY_UNAVAILABLE/);
  assert.match(e.conn(), /^offline/);
  res = okRes;
  await e.poll();
  ES.all[1].l.hello();
  await flush();
  assert.strictEqual(e.polling, 0);
  assert.strictEqual(e.wrap().tag, "table");
  assert.match(e.conn(), /^live/);
});

const X = require("../web/registry-ui-extra.js");

test("filters map to the claims query and reset paging", async () => {
  const q = { filter: "stale", q: "foo", page: 2, pageSize: 10, lineId: "l1", repo: "r" };
  assert.strictEqual(R.listUrl("claims", q),
    "/api/registry/claims?status=stale&q=foo&lineId=l1&repo=r&page=2&pageSize=10");
  assert.ok(!R.listUrl("archive", q).includes("lineId"));
  const e = env((u) => okRes(u));
  await e.v.load();
  e.v.state.page = 3;
  const owner = e.c.children[4].children[3];
  owner.value = "l1";
  owner.listeners.change();
  await flush();
  assert.strictEqual(e.v.state.page, 1);
  assert.match(e.calls.at(-2) + e.calls.at(-1), /lineId=l1/);
});

test("detailsModel covers merge failure and archived items", () => {
  const m = Object.fromEntries(X.detailsModel({ ...claim, tags: ["a", "b"], contract: "do X",
    mergeCheck: { verified: false, error: "boom", checkedAt: "t" } }));
  assert.strictEqual(m.Tags, "a, b");
  assert.strictEqual(m["Merge verified"], "no");
  assert.strictEqual(m["Merge error"], "boom");
  assert.strictEqual(m["Stale reason"], "owner deleted");
  const a = Object.fromEntries(X.detailsModel({ id: "a", archived: true, mergedAt: "m",
    mergeEvidence: { targetBranch: "main", strategy: "squash" } }));
  assert.strictEqual(a.Archived, "yes");
  assert.strictEqual(a["Target branch"], "main");
  assert.strictEqual(a.Commit, "-");
});

test("details load failure is inline and not global", async () => {
  const e = env((u) => (u.includes("/claims/") ? errRes(404, "gone", "NOT_FOUND") : okRes(u)));
  await e.v.load();
  const tr = e.wrap().children[1].children[0];
  tr.children[0].children[0].listeners.click();
  await flush();
  const rows = e.wrap().children[1].children;
  assert.match(rows[1].children[0].children[0].textContent, /Could not load details: NOT_FOUND: gone/);
  assert.strictEqual(e.err(), "");
  tr.children[0].children[0].listeners.click();
  assert.strictEqual(e.wrap().children[1].children.length, 1);
});

test("mergeEvents prepends, dedupes, caps", () => {
  const ev = (n) => ({ id: "e" + n, cursor: n });
  let list = X.mergeEvents([], [ev(1), ev(2)]);
  assert.deepStrictEqual(list.map((e) => e.cursor), [2, 1]);
  list = X.mergeEvents(list, [ev(2), ev(3)]);
  assert.deepStrictEqual(list.map((e) => e.cursor), [3, 2, 1]);
  const many = Array.from({ length: 60 }, (_, i) => ev(i + 10));
  assert.strictEqual(X.mergeEvents(list, many).length, 50);
  assert.strictEqual(X.lastCursor(list), 3);
  assert.strictEqual(X.eventRow({ at: "t", type: "x", claimId: "c" }).subject, "c");
});

test("events load, append on stream message, and reload when too old", async () => {
  const mkEv = (n) => ({ id: "e" + n, cursor: n, type: "t", at: "x" });
  let tooOld = false;
  const respond = (u) => {
    if (!u.includes("/events")) return okRes(u);
    const after = Number(/after=(\d+)/.exec(u)[1]);
    const all = Array.from({ length: 30 }, (_, i) => mkEv(i + 1)).filter((x) => x.cursor > after);
    return { ok: true, json: async () => ({ items: all, hasMore: false, tooOld: tooOld && after > 0 }) };
  };
  const e = env(respond, ES);
  e.v.start();
  await flush();
  assert.strictEqual(e.v.state.events.length, 20);
  assert.strictEqual(e.v.state.events[0].cursor, 30);
  ES.all[0].l.registry({ data: JSON.stringify({ revision: 5, eventCursor: 30 }) });
  assert.ok(!e.calls.some((u) => u.includes("after=30")));
  ES.all[0].l.registry({ data: JSON.stringify({ revision: 5, eventCursor: 31 }) });
  await flush();
  assert.ok(e.calls.some((u) => u.includes("after=30")));
  tooOld = true;
  ES.all[0].l.registry({ data: JSON.stringify({ revision: 5, eventCursor: 40 }) });
  await flush();
  assert.strictEqual(e.v.state.events.length, 20);
});

test("summary breakdown uses line names", () => {
  const b = X.breakdown({ claimsByOwner: { l1: 2, gone: 1 }, claimsByRepo: { r: 3 } }, [{ id: "l1", name: "Line A" }]);
  assert.deepStrictEqual(b.owners, ["gone: 1", "Line A: 2"]);
  assert.deepStrictEqual(b.repos, ["r: 3"]);
  assert.deepStrictEqual(X.repoOptions({ claimsByRepo: { b: 1, a: 1 } }), ["a", "b"]);
});
