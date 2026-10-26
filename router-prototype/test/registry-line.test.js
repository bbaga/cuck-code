"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const L = require("../web/registry-line.js");

const SHA = "a".repeat(40);

test("request-body builders produce exact JSON", () => {
  const f = { title: " T ", summary: "", tags: "a, b,,", repo: "r", branch: "b", commit: SHA, contract: "", status: "active" };
  assert.deepStrictEqual(L.createClaimBody(f, "k1"),
    { title: "T", tags: ["a", "b"], branch: "b", commit: SHA, status: "active", repo: "r", idempotencyKey: "k1" });
  assert.deepStrictEqual(L.editClaimBody({ ...f, contract: "c" }, 4),
    { expectedRevision: 4, title: "T", summary: "", tags: ["a", "b"], branch: "b", commit: SHA, contract: "c", status: "active" });
  assert.deepStrictEqual(L.renewBody(2), { expectedRevision: 2 });
  assert.deepStrictEqual(L.renewBody(2, "available"), { expectedRevision: 2, status: "available" });
  assert.deepStrictEqual(L.supersedeBody(3, " "), { expectedRevision: 3 });
  assert.deepStrictEqual(L.supersedeBody(3, "c9"), { expectedRevision: 3, byClaimId: "c9" });
  assert.deepStrictEqual(L.createRequestBody({ targetLineId: "t", subject: "s", text: "x", claimId: "" }, "k"),
    { targetLineId: "t", subject: "s", text: "x", idempotencyKey: "k" });
  assert.strictEqual(L.createRequestBody({ targetLineId: "t", subject: "s", text: "x", claimId: "c" }, "k").claimId, "c");
  assert.deepStrictEqual(L.answerBody("accepted", 1, { claimId: "c" }), { state: "accepted", expectedRevision: 1 });
  assert.deepStrictEqual(L.answerBody("fulfilled", 1, { claimId: "c", branch: "x" }), { state: "fulfilled", expectedRevision: 1, reference: { claimId: "c" } });
  assert.deepStrictEqual(L.answerBody("fulfilled", 1, { claimId: "", branch: "b", commit: SHA, contract: "k" }),
    { state: "fulfilled", expectedRevision: 1, reference: { branch: "b", commit: SHA, contract: "k" } });
});

test("client-side validation", () => {
  const ok = { title: "t", repo: "r", branch: "b", commit: SHA };
  assert.strictEqual(L.validateClaim(ok), "");
  assert.match(L.validateClaim({ ...ok, commit: SHA.toUpperCase() }), /40 lowercase hex/);
  assert.match(L.validateClaim({ ...ok, commit: "abc" }), /commit/);
  for (const k of ["title", "repo", "branch"]) assert.match(L.validateClaim({ ...ok, [k]: " " }), new RegExp(k));
  assert.match(L.validateRequest({ targetLineId: "", subject: "s", text: "t" }), /target/);
  assert.strictEqual(L.validateRequest({ targetLineId: "x", subject: "s", text: "t" }), "");
  assert.strictEqual(L.validateFulfil({ claimId: "c" }), "");
  assert.match(L.validateFulfil({ branch: "", commit: SHA }), /claim or/);
  assert.match(L.validateFulfil({ branch: "b", commit: "zz" }), /hex/);
  assert.strictEqual(L.validateFulfil({ branch: "b", commit: SHA }), "");
});

test("allowed actions per claim status and request state", () => {
  assert.deepStrictEqual(L.claimActions("active"), ["edit", "renew", "supersede"]);
  assert.deepStrictEqual(L.claimActions("stale"), ["renew", "supersede"]);
  assert.deepStrictEqual(L.claimActions("merged"), []);
  assert.deepStrictEqual(L.claimActions("superseded"), []);
  const r = (state, extra) => ({ state, targetLineId: "me", sourceLineId: "o", ...extra });
  assert.deepStrictEqual(L.requestActions(r("open"), "me"), ["accept", "decline"]);
  assert.deepStrictEqual(L.requestActions(r("accepted"), "me"), ["fulfill"]);
  assert.deepStrictEqual(L.requestActions(r("declined"), "me"), []);
  assert.deepStrictEqual(L.requestActions(r("open"), "o"), []);
  assert.deepStrictEqual(L.requestActions(r("open", { orphaned: true }), "me"), []);
});

test("error mapping and idempotency key reuse", () => {
  assert.deepStrictEqual(L.mapError(409, { error: "x", code: "STALE_REVISION", currentRevision: 5 }),
    { message: "Changed elsewhere — reloaded", panel: false, reload: true });
  assert.strictEqual(L.mapError(503, { error: "down", code: "REGISTRY_UNAVAILABLE" }).panel, true);
  assert.strictEqual(L.mapError(403, { error: "no", code: "FORBIDDEN_STATUS" }).message, "FORBIDDEN_STATUS: no");
  let n = 0;
  const k = L.createKeeper(() => "id" + ++n);
  assert.strictEqual(k.get({ a: 1 }), "id1");
  assert.strictEqual(k.get({ a: 1 }), "id1");
  assert.strictEqual(k.get({ a: 2 }), "id2");
  k.clear();
  assert.strictEqual(k.get({ a: 2 }), "id3");
});

function fakeDoc() {
  const mk = (tag) => ({ tag, children: [], listeners: {}, textContent: "", value: "", attrs: {},
    append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; },
    addEventListener(e, f) { this.listeners[e] = f; }, setAttribute(k, v) { this.attrs[k] = v; } });
  return { createElement: mk };
}
const walk = (n, f) => { if (typeof n === "string") return; f(n); (n.children || []).forEach((c) => walk(c, f)); };
const find = (n, pred) => { let r = null; walk(n, (x) => { if (!r && pred(x)) r = x; }); return r; };
const flush = () => new Promise((r) => setImmediate(r));

const claim = { id: "c1", title: "Mine", status: "active", revision: 3, branch: "b", commit: SHA, ownerLineId: "me", repo: "r" };
const json = (status, body) => ({ ok: status < 300, status, json: async () => body });

function setup(overrides = {}) {
  const calls = [];
  const respond = (u, o) => {
    if (overrides.write && o && o.method) return overrides.write(u, o);
    if (u.startsWith("/api/registry/claims")) return json(200, { items: [claim] });
    if (u.startsWith("/api/registry/requests")) return json(200, { items: [
      { id: "q1", subject: "Need X", sourceLineId: "o", targetLineId: "me", state: "open", revision: 1 },
      { id: "q2", subject: "Ask Y", sourceLineId: "me", targetLineId: "o", state: "open", revision: 2 }] });
    if (u === "/api/lines") return json(200, { lines: [{ id: "me", name: "Me" }, { id: "o", name: "Other" }] });
    if (u.includes("/repos")) return json(200, { repos: [{ name: "primary" }] });
    return json(404, {});
  };
  const c = fakeDoc().createElement("div");
  let n = 0;
  const v = L.mount(fakeDoc(), c, { fetch: async (u, o) => { calls.push({ u, o }); return respond(u, o); }, window: {}, lineId: "me", newId: () => "key" + ++n });
  return { c, v, calls };
}

test("mount renders lists, scoped to this line, and sends renew with expectedRevision", async () => {
  const { c, v, calls } = setup();
  await v.start();
  assert.ok(calls.some((x) => x.u === "/api/registry/claims?lineId=me&status=all&pageSize=100"));
  assert.match(find(c, (x) => /Mine/.test(x.textContent)).textContent, /Mine · active · rev 3 · b · aaaaaaaa/);
  assert.strictEqual(v.state.incoming.length, 1);
  assert.strictEqual(v.state.outgoing.length, 1);
  assert.ok(!find(c, (x) => x.tag === "option" && x.textContent === "Me"), "own line excluded from targets");
  find(c, (x) => x.tag === "button" && x.textContent === "Renew").listeners.click();
  await flush();
  const w = calls.find((x) => x.o && x.o.method === "POST");
  assert.strictEqual(w.u, "/api/registry/lines/me/claims/c1/renew");
  assert.deepStrictEqual(JSON.parse(w.o.body), { expectedRevision: 3 });
});

test("409 stale reloads and 503 shows the panel notice", async () => {
  let code = "STALE_REVISION", status = 409;
  const { c, v, calls } = setup({ write: () => json(status, { error: "stale", code, currentRevision: 9 }) });
  await v.start();
  const before = calls.length;
  find(c, (x) => x.tag === "button" && x.textContent === "Accept").listeners.click();
  await flush(); await flush();
  assert.ok(calls.length > before + 1, "list reloaded");
  const li = find(c, (x) => x.tag === "li" && /Need X/.test(x.textContent));
  assert.strictEqual(c.children[0].textContent === "Changed elsewhere — reloaded", true);
  code = "REGISTRY_UNAVAILABLE"; status = 503;
  find(c, (x) => x.tag === "button" && x.textContent === "Decline").listeners.click();
  await flush();
  assert.strictEqual(c.children[0].textContent, "REGISTRY_UNAVAILABLE");
  assert.ok(li);
});

test("publish form validates, then reuses the idempotency key on retry", async () => {
  let fail = true;
  const { c, v, calls } = setup({ write: () => (fail ? json(503, { error: "d", code: "REGISTRY_UNAVAILABLE" }) : json(201, { claim })) });
  await v.start();
  const form = c.children[4];
  const inputs = [];
  walk(form, (x) => { if (x.tag === "input" || x.tag === "select") inputs.push(x); });
  const [, repoTxt, title, , , branch, commit] = inputs;
  const submit = () => form.listeners.submit({ preventDefault() {} });
  await submit();
  assert.match(find(form, (x) => x.attrs.role === "alert").textContent, /title is required/);
  title.value = "T"; branch.value = "b"; commit.value = SHA;
  await submit(); await submit();
  fail = false;
  await submit();
  const posts = calls.filter((x) => x.u === "/api/registry/lines/me/claims" && x.o.method === "POST").map((x) => JSON.parse(x.o.body));
  assert.strictEqual(posts.length, 3);
  assert.deepStrictEqual(new Set(posts.map((p) => p.idempotencyKey)), new Set(["key1"]));
  assert.strictEqual(posts[0].repo, "primary");
  assert.ok(repoTxt);
});

test("plain-script vm load (no require/module) and mount", async () => {
  const ctx = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../web/registry-line.js"), "utf8"), ctx, { filename: "registry-line.js" });
  assert.strictEqual(typeof ctx.registryLine.mount, "function");
  assert.strictEqual(ctx.registryLine.validCommit(SHA), true);
  const c = fakeDoc().createElement("div");
  const v = ctx.registryLine.mount(fakeDoc(), c, { fetch: async () => ({ ok: true, json: async () => ({ items: [], lines: [] }) }), window: {}, lineId: "me" });
  await v.start();
  assert.strictEqual(find(c, (x) => x.textContent === "No claims yet.") !== null, true);
});
