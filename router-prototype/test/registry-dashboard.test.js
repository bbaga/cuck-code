"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const html = fs.readFileSync(require.resolve("../web/index.html"), "utf8");
const start = html.indexOf("  async function allPages(path)");
const end = html.indexOf("  async function load()", start);
const source = html.slice(start, end);
test("page traversal loads every page", async () => {
  let calls = 0;
  const context = { URL, location: { href: "http://localhost/" }, fetch: async () => {
    calls++;
    return { ok: true, json: async () => ({ items: [calls], hasMore: calls < 3 }) };
  } };
  const fn = vm.runInNewContext(source + "; allPages", context);
  assert.deepEqual(Array.from(await fn("/items")), [1, 2, 3]);
});
test("registry text uses textContent and refresh reloads", () => {
  assert.match(html, /el\.textContent = value/);
  assert.match(html, /registryRefresh[\s\S]*?addEventListener\("click", load\)/);
});
test("archives show source lines and verified merge reference and status", () => {
  assert.match(html, /item\.sourceLineId \|\| item\.lineId/);
  assert.match(html, /item\.mergeReference \|\| item\.mergeEvidence/);
  assert.match(html, /item\.status/);
});
test("event replay uses the durable cursor", () => {
  assert.match(html, /localStorage\.getItem\("registryCursor"\)/);
  assert.match(html, /localStorage\.setItem\("registryCursor"/);
});
test("inbound request answer uses its expected revision", () => {
  assert.match(html, /id="answerForm"/);
  assert.match(html, /expectedRequestRevision: Number\(d\.get\("revision"\)\)/);
  assert.match(html, /res\.status === 409[\s\S]*?return/);
});
