"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseMarkdown, renderMarkdown } = require("../web/markdown-renderer.js");

function documentFixture() {
  const node = (tag, value) => ({ tag, value: value || "", children: [], attributes: {}, appendChild(child) { this.children.push(child); }, setAttribute(name, value) { this.attributes[name] = value; }, get textContent() { return this.value || this.children.map(c => c.textContent || c.value || "").join(""); } });
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

test("parses and renders inline tokens without formatting code", () => {
  const source = "**strong** and *em* and `*code*` [site](https://example.test/a_(b))  \nnext";
  const tree = parseMarkdown(source);
  assert.deepEqual(tree.children[0].text, source);
  const fragment = renderMarkdown(documentFixture(), tree);
  const paragraph = fragment.children[0];
  assert.deepEqual(paragraph.children.map(node => node.tag), ["strong", "#text", "em", "#text", "code", "#text", "a", "br", "#text"]);
  assert.equal(paragraph.children[4].textContent, "*code*");
  assert.equal(paragraph.children[6].attributes.href, "https://example.test/a_(b)");
});

test("keeps unsafe, malformed, and raw payloads as text", () => {
  const source = "[x](javascript:alert(1)) [x](data:text/html,x) [x](//evil) <img onerror=alert(1)>";
  const fragment = renderMarkdown(documentFixture(), source);
  const paragraph = fragment.children[0];
  assert.equal(paragraph.children.some(node => node.tag === "a"), false);
  assert.match(paragraph.textContent, /javascript:alert/);
  assert.equal(paragraph.children.some(node => node.tag === "img"), false);
});

test("supports mixed case safe protocols and rejects control characters", () => {
  const fragment = renderMarkdown(documentFixture(), "[mail](MAILTO:user@example.test) [web](HtTpS://example.test) [bad](java\\u0000script:x)");
  const links = fragment.children[0].children.filter(node => node.tag === "a");
  assert.equal(links.length, 2);
  assert.equal(links[0].attributes.rel, "noopener noreferrer");
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
