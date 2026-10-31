"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
const rendererSource = fs.readFileSync(path.join(__dirname, "../web/markdown-renderer.js"), "utf8");

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.className = ""; }
  appendChild(c) {
    if (c.tag === "#fragment") this.children.push(...c.children); else this.children.push(c);
    return c;
  }
  append(...c) { c.forEach((x) => this.appendChild(x)); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  set textContent(v) { this.children = [{ tag: "#text", t: String(v) }]; }
}
const doc = {
  createElement: (t) => new El(t),
  createTextNode: (t) => ({ tag: "#text", t }),
  createDocumentFragment: () => new El("#fragment"),
};

function load(withRenderer = true) {
  const win = {};
  if (withRenderer) vm.runInNewContext(rendererSource, { window: win, self: win, globalThis: win });
  const ctx = { document: doc, window: win, Date };
  const start = html.indexOf("function textOf(entry)");
  const end = html.indexOf("async function renderPlan");
  vm.runInNewContext(html.slice(start, end) + ";this.entryEl = entryEl;", ctx);
  return ctx.entryEl;
}

const walk = (n, out = []) => { out.push(n); (n.children || []).forEach((c) => walk(c, out)); return out; };
const tags = (n) => walk(n).map((x) => x.tag);
const MD = "# Title\n\n- one\n- two\n\n```\ncode line\n```\n\n[site](https://example.com/a)";
const HOSTILE = "<script>alert(1)</script><img src=x onerror=alert(1)><iframe src=x></iframe>\n\n[bad](javascript:alert(1))";
const msg = (role, content, extra) => ({ type: "message", role, content, ...extra });
const MD_TAGS = ["h1", "ul", "a", "code"];

test("assistant entry with Markdown gives heading, list, code and link", () => {
  const t = tags(load()(msg("assistant", MD)));
  for (const want of ["h1", "ul", "li", "pre", "code", "a"]) assert.ok(t.includes(want), want);
});

test("user entry with Markdown stays one literal text node", () => {
  const div = load()(msg("user", MD));
  assert.equal(div.className, "user");
  assert.deepEqual(div.children, [{ tag: "#text", t: "> " + MD }]);
});

test("router, system and reasoning entries stay literal", () => {
  const el = load();
  const router = el(msg("user", MD, { origin: "router" }));
  assert.ok(!tags(router).some((t) => MD_TAGS.includes(t)));
  assert.equal(walk(router).find((n) => n.tag === "pre").children[0].t, MD);
  assert.deepEqual(el(msg("system", MD)).children, [{ tag: "#text", t: MD }]);
  const reasoning = el({ type: "reasoning", text: MD });
  assert.ok(!tags(reasoning).some((t) => MD_TAGS.includes(t)));
  assert.equal(walk(reasoning).find((n) => n.tag === "pre").children[0].t, MD);
});

test("hostile assistant text gives no script, img, iframe, handler or javascript: href", () => {
  for (const n of walk(load()(msg("assistant", HOSTILE)))) {
    assert.ok(!["script", "img", "iframe"].includes(n.tag), n.tag);
    for (const [k, v] of Object.entries(n.attrs || {})) {
      assert.ok(!/^on/i.test(k), k);
      assert.ok(!/^\s*javascript:/i.test(v), v);
    }
  }
});

test("hostile user text stays literal", () => {
  const div = load()(msg("user", HOSTILE));
  assert.deepEqual(div.children, [{ tag: "#text", t: "> " + HOSTILE }]);
});

test("pre blocks scroll sideways in the CSS", () => {
  const rule = html.match(/\n  \.transcript \.assistant pre \{[^}]*\}/)[0];
  assert.match(rule, /overflow-x:\s*auto/);
  assert.match(rule, /max-width:\s*100%/);
});

test("rendering the same entry twice gives the same DOM", () => {
  const el = load();
  const e = msg("assistant", MD);
  assert.deepEqual(el(e), el(e));
});

test("assistant entry falls back to a text node without the renderer", () => {
  const div = load(false)(msg("assistant", MD));
  assert.equal(div.className, "assistant");
  assert.deepEqual(div.children, [{ tag: "#text", t: MD }]);
});
