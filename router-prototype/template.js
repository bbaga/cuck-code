"use strict";

// Prompt templates are Handlebars (https://handlebarsjs.com). The router
// compiles them in a restricted mode:
//   - no HTML escaping, and a line that holds only a block tag keeps its line break;
//   - a variable with no value (missing, undefined or null) throws; a missing name in
//     {{#if}} or {{#each}} counts as not set;
//   - only {{path}}, {{#if path}}, {{#unless path}}, {{#each path}}, {{else}} and
//     {{!comments}} are allowed: no helpers with arguments, partials, sub-expressions,
//     raw blocks or "../" paths. Use {{@root.name}} to reach a top-level value inside {{#each}}.

const Handlebars = require("handlebars").create();

const PART_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const BLOCKS = ["if", "unless", "each"];

class TemplateError extends Error {
  constructor(message, { line, column, name } = {}) {
    super(line ? `${message} (line ${line}, column ${column})` : message);
    this.name = "TemplateError";
    if (line !== undefined) this.line = line;
    if (column !== undefined) this.column = column;
    if (name !== undefined) this.variable = name;
  }
}

function at(node, message, name) {
  const start = node && node.loc && node.loc.start;
  return new TemplateError(message, start ? { line: start.line, column: start.column + 1, name } : { name });
}

// The innermost block tag that nothing closes, found by a plain scan: Handlebars reports
// an unclosed block at the end of the text, but the useful place is its open tag.
function unclosedBlock(text) {
  const stack = [];
  const tag = /\{\{([#\/])\s*([^\s}]+)[^}]*\}\}/g;
  let m;
  while ((m = tag.exec(text))) {
    if (m[1] === "#") stack.push({ name: m[2], index: m.index });
    else if (stack.length) stack.pop();
  }
  if (!stack.length) return null;
  const top = stack[stack.length - 1];
  const before = text.slice(0, top.index).split("\n");
  return { name: top.name, line: before.length, column: before[before.length - 1].length + 1 };
}

// A Handlebars error to a TemplateError with a line and a column.
function fromHandlebars(err, text) {
  if (err instanceof TemplateError) return err;
  const raw = String(err && err.message || err);
  const first = raw.split("\n")[0];
  const near = /Parse error on line (\d+)/.exec(first);
  if (near) {
    const got = /got '([A-Z_]+)'/.exec(raw);
    const line = Number(near[1]);
    if (got && got[1] === "EOF") {
      const open = typeof text === "string" ? unclosedBlock(text) : null;
      if (open) return new TemplateError(`Section "${open.name}" is not closed`, { line: open.line, column: open.column });
      return new TemplateError("Section is not closed", { line, column: 1 });
    }
    if (got && got[1] === "OPEN_ENDBLOCK") return new TemplateError("Close tag has no open tag", { line, column: 1 });
    if (got && got[1] === "INVALID") return new TemplateError("Tag is not closed or has a bad name", { line, column: 1 });
    return new TemplateError("Syntax error", { line, column: 1 });
  }
  if (err && Number.isInteger(err.lineNumber)) {
    return new TemplateError(first.replace(/ - \d+:\d+$/, ""), { line: err.lineNumber, column: (err.column || 0) + 1 });
  }
  return new TemplateError(first);
}

function parseSource(text) {
  if (typeof text !== "string") throw new TemplateError("Template must be a string");
  try {
    return Handlebars.parse(text, { ignoreStandalone: true });
  } catch (err) {
    throw fromHandlebars(err, text);
  }
}

// The dotted name of a path, with "{{@root.x}}" read as "x". Throws for what is not allowed.
function pathName(path) {
  if (!path || path.type !== "PathExpression") throw at(path, "Only a plain name is allowed here");
  if (path.depth > 0) throw at(path, `Use {{@root.name}} instead of "${path.original}"`);
  let parts = path.parts;
  if (path.data) {
    if (path.parts[0] !== "root" || path.parts.length < 2) throw at(path, `Unsupported "@${path.original.slice(1)}"`);
    parts = path.parts.slice(1);
  }
  if (path.this) throw at(path, `Unsupported "${path.original}"`);
  if (!parts.length || !parts.every((p) => PART_RE.test(p))) throw at(path, `Bad name "${path.original}"`);
  return parts.join(".");
}

// Walk the tree, check what is allowed, and report each variable and block.
function walk(node, open, on) {
  for (const s of node.body) {
    if (s.type === "ContentStatement" || s.type === "CommentStatement") continue;
    if (s.type === "MustacheStatement") {
      if (s.params.length || s.hash) throw at(s, "Helpers with arguments are not allowed");
      on.variable(pathName(s.path), open);
    } else if (s.type === "BlockStatement") {
      const kind = s.path.original;
      if (!BLOCKS.includes(kind) || s.path.type !== "PathExpression") {
        throw at(s, `Block "${s.path.original}" is not allowed: use {{#if x}}, {{#unless x}} or {{#each x}}`);
      }
      if (s.params.length !== 1 || s.hash) throw at(s, `{{#${kind}}} needs exactly one name`);
      const name = pathName(s.params[0]);
      on.block(name, kind === "unless");
      // The part that renders only when the value is set may use it.
      const guarded = [...open, name];
      if (s.program) walk(s.program, kind === "unless" ? open : guarded, on);
      if (s.inverse) walk(s.inverse, kind === "unless" ? guarded : open, on);
    } else {
      throw at(s, `${s.type.replace("Statement", "")} is not allowed in a template`);
    }
  }
}

// Check the syntax of a template and return its tree. Throws TemplateError.
function parseTemplate(text) {
  const ast = parseSource(text);
  walk(ast, [], { variable() {}, block() {} });
  return ast;
}

// The variables of a template, its blocks, and for each variable the names of the
// blocks around it that render only when the name is set.
function placeholders(text) {
  const vars = new Set();
  const sections = new Map();
  const varSections = new Map();
  walk(parseSource(text), [], {
    variable(name, open) {
      vars.add(name);
      const list = varSections.get(name) || [];
      for (const s of open) if (!list.includes(s)) list.push(s);
      varSections.set(name, list);
    },
    block(name, inverted) { sections.set(name, { inverted }); },
  });
  return { vars, sections, varSections };
}

// {{name}} becomes {{__value name "name"}}, a helper that throws when there is no value.
Handlebars.registerHelper("__value", (value, name) => {
  if (value === undefined || value === null) {
    throw new TemplateError(`Missing value "${name}"`, { name });
  }
  return String(value);
});

function requireValues(node) {
  for (const s of node.body) {
    if (s.type === "MustacheStatement") {
      const name = pathName(s.path);
      s.params = [s.path, { type: "StringLiteral", value: name, original: name, loc: s.loc }];
      s.path = { type: "PathExpression", data: false, depth: 0, parts: ["__value"], original: "__value",
        this: false, loc: s.loc };
    } else if (s.type === "BlockStatement") {
      if (s.program) requireValues(s.program);
      if (s.inverse) requireValues(s.inverse);
    }
  }
}

const compiled = new Map();

function compile(text) {
  let fn = compiled.get(text);
  if (!fn) {
    parseTemplate(text);
    const ast = parseSource(text);
    requireValues(ast);
    fn = Handlebars.compile(ast, { noEscape: true, ignoreStandalone: true });
    compiled.set(text, fn);
    if (compiled.size > 500) compiled.delete(compiled.keys().next().value);
  }
  return fn;
}

function run(text, values) {
  try {
    return compile(text)(values);
  } catch (err) {
    if (err instanceof TemplateError) throw err;
    throw new TemplateError(String(err && err.message || err));
  }
}

// The task marker splits a node prompt into a role part and a task part
// (task B5). render drops it with its line break, so the plain text of a body
// is the same as without the marker. buildPromptParts asks to keep it.
const TASK_MARKER = "<!-- task -->";
const TASK_MARKER_LINE = /<!-- task -->\n?/g;

function render(text, values = {}, options = {}) {
  const rendered = run(text, values);
  return options.keepTaskMarker === true ? rendered : rendered.replace(TASK_MARKER_LINE, "");
}

module.exports = { TemplateError, parseTemplate, placeholders, render, TASK_MARKER, TASK_MARKER_LINE };
