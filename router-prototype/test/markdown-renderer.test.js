"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseMarkdown, renderMarkdown } = require("../web/markdown-renderer.js");

function documentFixture() {
  const node = (tag, value) => ({ tag, value: value || "", children: [], appendChild(child) { this.children.push(child); }, get textContent() { return this.value || this.children.map(c => c.textContent || c.value || "").join(""); } });
  return { createDocumentFragment: () => node("#fragment"), createElement: tag => node(tag), createTextNode: value => node("#text", String(value)) };
}

test("parses stable block token shapes", () => {
  assert.deepEqual(parseMarkdown("# Title\n\ntext\n\n- one\n- two\n\n> note"), {
    type: "document", children: [
      { type: "heading", level: 1, text: "Title" },
      { type: "paragraph", text: "text" },
      { type: "list", ordered: false, items: [
        { type: "listItem", children: [{ type: "paragraph", text: "one" }] },
        { type: "listItem", children: [{ type: "paragraph", text: "two" }] },
      ] },
      { type: "quote", children: [{ type: "paragraph", text: "note" }] },
    ],
  });
});

test("keeps code opaque, including incomplete fences and markers", () => {
  const tree = parseMarkdown("```js\n<em>& **x** `y`\n");
  assert.equal(tree.children[0].type, "code");
  assert.equal(tree.children[0].text, "<em>& **x** `y`");
  assert.equal(tree.children[0].closed, false);
});

test("handles empty, Unicode, raw HTML, and long code", () => {
  assert.deepEqual(parseMarkdown(""), { type: "document", children: [] });
  assert.equal(parseMarkdown("こんにちは").children[0].text, "こんにちは");
  assert.equal(parseMarkdown("<script>alert(1)</script>").children[0].text, "<script>alert(1)</script>");
  assert.equal(parseMarkdown("```\n" + "x".repeat(10000) + "\n```").children[0].text.length, 10000);
});

test("renders only fixed elements and text nodes", () => {
  const fragment = renderMarkdown(documentFixture(), parseMarkdown("# <script>\n\n- **literal**\n\n```\n<img> &\n```") );
  assert.deepEqual(fragment.children.map(n => n.tag), ["h1", "ul", "pre"]);
  assert.equal(fragment.children[0].textContent, "<script>");
  assert.equal(fragment.children[2].textContent, "<img> &");
});

test("preserves eight nested list levels in tokens and DOM hierarchy", () => {
  const lines = Array.from({ length: 8 }, (_, level) => `${"  ".repeat(level)}- level-${level + 1}`);
  const tree = parseMarkdown(lines.join("\n"));
  let list = tree.children[0];
  for (let level = 1; level <= 8; level++) {
    assert.equal(list.type, "list");
    assert.equal(list.items[0].children[0].text, `level-${level}`);
    if (level < 8) list = list.items[0].children[1];
  }
  const fragment = renderMarkdown(documentFixture(), tree);
  let element = fragment.children[0];
  for (let level = 1; level <= 8; level++) {
    assert.equal(element.tag, level === 1 ? "ul" : "ul");
    const li = element.children[0];
    assert.equal(li.children[0].textContent, `level-${level}`);
    if (level < 8) element = li.children[1];
  }
});

test("supports list depths 1, 2, 3, and keeps depth 9 as literal fallback", () => {
  const lines = Array.from({ length: 9 }, (_, level) => `${"  ".repeat(level)}- level-${level + 1}`);
  const tree = parseMarkdown(lines.join("\n"));
  let list = tree.children[0];
  for (let level = 1; level <= 8; level++) list = level === 8 ? list.items[0].children[1] : list.items[0].children[1];
  assert.equal(list.type, "paragraph");
  assert.match(list.text, /level-9/);
});
