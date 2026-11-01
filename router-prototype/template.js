"use strict";

// Small mustache subset: {{name}}, {{a.b}}, {{#name}}..{{/name}}, {{^name}}..{{/name}}.
// No logic, no escaping, no I/O.

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;

class TemplateError extends Error {
  constructor(message, { line, column, name } = {}) {
    super(line ? `${message} (line ${line}, column ${column})` : message);
    this.name = "TemplateError";
    if (line !== undefined) this.line = line;
    if (column !== undefined) this.column = column;
    if (name !== undefined) this.variable = name;
  }
}

function position(text, index) {
  let line = 1;
  let column = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === "\n") { line++; column = 1; } else column++;
  }
  return { line, column };
}

function fail(text, index, message) {
  throw new TemplateError(message, position(text, index));
}

function parseTemplate(text) {
  if (typeof text !== "string") throw new TemplateError("Template must be a string");
  const root = [];
  const stack = []; // { node, index }
  let children = root;
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{{", i);
    if (open === -1) {
      children.push({ type: "text", value: text.slice(i) });
      break;
    }
    if (open > i) children.push({ type: "text", value: text.slice(i, open) });
    const close = text.indexOf("}}", open + 2);
    if (close === -1) fail(text, open, "Tag is not closed");
    const inner = text.slice(open + 2, close);
    i = close + 2;
    const sigil = inner[0];
    if (sigil === "#" || sigil === "^") {
      const name = inner.slice(1);
      if (!NAME_RE.test(name)) fail(text, open, `Bad name "${name}"`);
      const node = { type: "section", name, inverted: sigil === "^", children: [] };
      children.push(node);
      stack.push({ node, index: open });
      children = node.children;
    } else if (sigil === "/") {
      const name = inner.slice(1);
      if (!NAME_RE.test(name)) fail(text, open, `Bad name "${name}"`);
      if (!stack.length) fail(text, open, `Close tag "${name}" has no open tag`);
      const top = stack[stack.length - 1];
      if (top.node.name !== name) {
        fail(text, open, `Close tag "${name}" does not match open tag "${top.node.name}"`);
      }
      stack.pop();
      children = stack.length ? stack[stack.length - 1].node.children : root;
    } else {
      if (!NAME_RE.test(inner)) fail(text, open, `Bad name "${inner}"`);
      children.push({ type: "var", name: inner });
    }
  }
  if (stack.length) {
    const top = stack[stack.length - 1];
    fail(text, top.index, `Section "${top.node.name}" is not closed`);
  }
  return root;
}

function placeholders(text) {
  const vars = new Set();
  const sections = new Map();
  const varSections = new Map(); // var name -> names of all containing sections
  const walk = (nodes, open) => {
    for (const node of nodes) {
      if (node.type === "var") {
        vars.add(node.name);
        const list = varSections.get(node.name) || [];
        for (const s of open) if (!list.includes(s)) list.push(s);
        varSections.set(node.name, list);
      } else if (node.type === "section") {
        sections.set(node.name, { inverted: node.inverted });
        walk(node.children, [...open, node.name]);
      }
    }
  };
  walk(parseTemplate(text), []);
  return { vars, sections, varSections };
}

const MISSING = Symbol("missing");

function lookup(scopes, name) {
  const parts = name.split(".");
  for (let s = scopes.length - 1; s >= 0; s--) {
    const scope = scopes[s];
    if (scope === null || typeof scope !== "object") continue;
    if (scope[parts[0]] === undefined) continue;
    let value = scope;
    for (const part of parts) {
      if (value === null || typeof value !== "object" || value[part] === undefined) return MISSING;
      value = value[part];
    }
    return value;
  }
  return MISSING;
}

function isFalsy(value) {
  return value === MISSING || value === undefined || value === null || value === false ||
    value === "" || (Array.isArray(value) && value.length === 0);
}

function renderNodes(nodes, scopes, out) {
  for (const node of nodes) {
    if (node.type === "text") {
      out.push(node.value);
    } else if (node.type === "var") {
      const value = lookup(scopes, node.name);
      if (value === MISSING || value === null) {
        throw new TemplateError(`Missing value "${node.name}"`, { name: node.name });
      }
      out.push(String(value));
    } else {
      const value = lookup(scopes, node.name);
      if (node.inverted) {
        if (isFalsy(value)) renderNodes(node.children, scopes, out);
      } else if (Array.isArray(value)) {
        for (const item of value) renderNodes(node.children, [...scopes, item], out);
      } else if (!isFalsy(value)) {
        const next = typeof value === "object" ? [...scopes, value] : scopes;
        renderNodes(node.children, next, out);
      }
    }
  }
}

function render(text, values = {}) {
  const out = [];
  renderNodes(parseTemplate(text), [values], out);
  return out.join("");
}

module.exports = { TemplateError, parseTemplate, placeholders, render };
