"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { allowedHosts, guardRequest } = require("../http-guard");

const allowed = allowedHosts("");
const req = (method, headers) => ({ method, headers });

test("accepts same-origin and non-browser requests on loopback hosts", () => {
  assert.equal(guardRequest(req("GET", { host: "localhost:7788" }), allowed), null);
  assert.equal(guardRequest(req("POST", { host: "127.0.0.1:7788" }), allowed), null);
  assert.equal(guardRequest(req("POST", { host: "[::1]:7788", origin: "http://[::1]:7788" }), allowed), null);
  assert.equal(guardRequest(req("POST", { ":authority": "localhost:7789", origin: "https://localhost:7789" }), allowed), null);
});

test("refuses unknown hosts on every method", () => {
  assert.equal(guardRequest(req("GET", { host: "attacker.example:7788" }), allowed).status, 403);
  assert.equal(guardRequest(req("GET", {}), allowed).status, 403);
});

test("refuses cross-origin state changes", () => {
  const host = "localhost:7788";
  assert.equal(guardRequest(req("POST", { host, origin: "https://attacker.example" }), allowed).status, 403);
  assert.equal(guardRequest(req("POST", { host, origin: "http://localhost:3000" }), allowed).status, 403);
  assert.equal(guardRequest(req("DELETE", { host, origin: "null" }), allowed).status, 403);
  assert.equal(guardRequest(req("PUT", { host, "sec-fetch-site": "cross-site" }), allowed).status, 403);
});

test("accepts extra host names only when configured", () => {
  const lan = allowedHosts("router.lan, Box.Local");
  assert.equal(guardRequest(req("GET", { host: "router.lan:7788" }), lan), null);
  assert.equal(guardRequest(req("GET", { host: "box.local" }), lan), null);
  assert.equal(guardRequest(req("GET", { host: "router.lan:7788" }), allowed).status, 403);
});
