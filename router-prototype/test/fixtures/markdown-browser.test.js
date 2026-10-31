"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startMarkdownFixture } = require("./markdown-browser.js");

const asset = fs.readFileSync(path.resolve(__dirname, "../../web/markdown-renderer.js"), "utf8");
let fixture;
test.before(async () => { fixture = await startMarkdownFixture({ port: 0 }); });
test.after(async () => { await fixture.close(); });

async function get(route) {
  const response = await fetch(new URL(route, fixture.url));
  return { response, body: await response.text() };
}

test("serves the fixture page and unchanged renderer asset", async () => {
  const root = await get("/");
  assert.equal(root.response.status, 200);
  assert.match(root.response.headers.get("content-type"), /^text\/html/);
  assert.match(root.body, /id="markdown-root"/);
  const script = await get("/web/markdown-renderer.js");
  assert.equal(script.response.status, 200);
  assert.match(script.response.headers.get("content-type"), /^text\/javascript/);
  assert.equal(script.body, asset);
});

test("returns 404 for unknown and unsupported routes", async () => {
  const unknown = await get("/unknown");
  assert.equal(unknown.response.status, 404);
  const post = await fetch(new URL("/", fixture.url), { method: "POST" });
  assert.equal(post.status, 404);
});

test("binds to loopback and does not start on import", async () => {
  assert.equal(new URL(fixture.url).hostname, "127.0.0.1");
  const child = require("node:child_process").spawnSync(process.execPath, ["-e", "require('./test/fixtures/markdown-browser.js')"], { cwd: path.resolve(__dirname, "../..") });
  assert.equal(child.status, 0);
  assert.equal(child.stdout.toString(), "");
});

test("close is awaitable and rejects new connections", async () => {
  const running = await startMarkdownFixture({ port: 0 });
  const url = running.url;
  await running.close();
  await assert.rejects(fetch(url));
});
