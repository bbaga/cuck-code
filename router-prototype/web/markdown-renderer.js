"use strict";

// A small block parser. It does not interpret inline Markdown.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.markdownRenderer = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const MAX_NESTING = 8;

  function text(value) { return String(value == null ? "" : value); }

  function parseMarkdown(source) {
    const lines = text(source).replace(/\r\n?/g, "\n").split("\n");
    if (lines.length === 1 && lines[0] === "") return { type: "document", children: [] };
    return { type: "document", children: parseBlocks(lines, 0) };
  }

  function parseBlocks(lines, depth) {
    if (depth >= MAX_NESTING) return lines.length ? [{ type: "paragraph", text: lines.join("\n") }] : [];
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        const marker = fence[1][0], size = fence[1].length;
        const body = [], start = i++;
        let closed = false;
        while (i < lines.length) {
          if (new RegExp("^ {0,3}" + marker + "{" + size + ",}\\s*$").test(lines[i])) { closed = true; i++; break; }
          body.push(lines[i++]);
        }
        if (body.length && body[body.length - 1] === "") body.pop();
        out.push({ type: "code", text: body.join("\n"), language: null, fenced: true, closed, start });
        continue;
      }
      const heading = line.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/);
      if (heading) { out.push({ type: "heading", level: heading[1].length, text: heading[2].replace(/[ \t]+#*[ \t]*$/, "") }); i++; continue; }
      if (/^ {0,3}>/.test(line)) {
        const quoted = [];
        while (i < lines.length && (/^ {0,3}>/.test(lines[i]) || !lines[i].trim())) {
          quoted.push(lines[i].replace(/^ {0,3}>[ \t]?/, "")); i++;
        }
        out.push({ type: "quote", children: parseBlocks(quoted, depth + 1) });
        continue;
      }
      const list = line.match(/^( {0,3})([-+*]|\d+[.)])[ \t]+(.*)$/);
      if (list) { const result = parseList(lines, i, depth + 1, list[1].length); out.push(result.token); i = result.next; continue; }
      const paragraph = [line]; i++;
      while (i < lines.length && lines[i].trim() && !/^( {0,3})(#{1,6})(?:[ \t]+|$)/.test(lines[i]) && !/^( {0,3})([-+*]|\d+[.)])[ \t]+/.test(lines[i]) && !/^ {0,3}>/.test(lines[i]) && !/^ {0,3}(`{3,}|~{3,})/.test(lines[i])) paragraph.push(lines[i++]);
      out.push({ type: "paragraph", text: paragraph.join("\n") });
    }
    return out;
  }

  function parseList(lines, start, depth, indent) {
    const first = lines[start].match(/^ {0,3}([-+*]|\d+[.)])[ \t]+(.*)$/);
    const ordered = /^\d/.test(first[1]), items = [];
    let i = start;
    while (i < lines.length) {
      const match = lines[i].match(/^( *)([-+*]|\d+[.)])[ \t]+(.*)$/);
      if (!match || match[1].length !== indent || (/^\d/.test(match[2])) !== ordered) break;
      const item = { type: "listItem", children: [{ type: "paragraph", text: match[3] }] }; i++;
      const nested = [];
      while (i < lines.length) {
        if (lines[i].trim() === "") { nested.push(""); i++; continue; }
        const spaces = lines[i].match(/^ */)[0].length;
        if (spaces <= indent) break;
        nested.push(lines[i]);
        i++;
      }
      if (nested.length) {
        // depth counts list levels: the first list is 1, so level 8 is supported.
        const childIndent = nested.find(line => line.trim())?.match(/^ */)[0].length || indent + 1;
        const childLines = nested.map(line => line.trim() ? line.slice(Math.min(childIndent, line.length)) : "");
        if (depth < MAX_NESTING) item.children.push(...parseBlocks(childLines, depth));
        else item.children.push({ type: "paragraph", text: childLines.join("\n") });
      }
      items.push(item);
    }
    return { token: { type: "list", ordered, items }, next: i };
  }

  function appendText(document, parent, value) { parent.appendChild(document.createTextNode(text(value))); }
  function renderMarkdown(document, source) {
    if (!document || typeof document.createDocumentFragment !== "function") throw new TypeError("A document is required");
    const fragment = document.createDocumentFragment();
    const tree = source && source.type === "document" ? source : parseMarkdown(source);
    function renderBlocks(parent, children) {
      for (const token of children || []) {
        let element;
        if (token.type === "paragraph") { element = document.createElement("p"); appendText(document, element, token.text); }
        else if (token.type === "heading") { element = document.createElement("h" + Math.min(6, Math.max(1, token.level))); appendText(document, element, token.text); }
        else if (token.type === "code") { element = document.createElement("pre"); const code = document.createElement("code"); appendText(document, code, token.text); element.appendChild(code); }
        else if (token.type === "quote") { element = document.createElement("blockquote"); renderBlocks(element, token.children); }
        else if (token.type === "list") { element = document.createElement(token.ordered ? "ol" : "ul"); for (const item of token.items) { const li = document.createElement("li"); renderBlocks(li, item.children); element.appendChild(li); } }
        else continue;
        parent.appendChild(element);
      }
    }
    renderBlocks(fragment, tree.children);
    return fragment;
  }

  return { parseMarkdown, renderMarkdown, MAX_NESTING };
});
