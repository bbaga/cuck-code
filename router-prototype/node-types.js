"use strict";

const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { splitFrontmatter, FormatError } = require("./frontmatter");
const { parseTemplate, placeholders, TemplateError } = require("./template");
const { checkDeclaration, checkOptionalUse, isRouterVariable } = require("./fields");

const KEYS = ["name", "description", "extends", "session", "workspace", "outcome", "coordinator", "requires", "fields"];
const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ENUMS = {
  session: ["resume", "fresh"],
  workspace: ["coordinator", "own-worktree", "source", "integration"],
  outcome: ["none", "verdict"],
};
const REQUIRES = ["accepted-work"];

// Every error names the file, and the line when known.
class NodeTypeError extends FormatError {
  constructor(file, line, message) {
    super(file, line, line ? `${file}:${line}: ${message}` : `${file}: ${message}`);
  }
}

function isMapping(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function loadNodeType(dirName, readFile) {
  const file = `${dirName.replace(/[\\/]+$/, "")}/NODE.md`;
  const fail = (line, message) => { throw new NodeTypeError(file, line, message); };

  let text;
  try {
    text = readFile(file);
  } catch (err) {
    fail(undefined, `cannot read file: ${err.message}`);
  }
  let parts;
  try {
    parts = splitFrontmatter(text, file);
  } catch (err) {
    if (err instanceof FormatError) fail(err.line, err.message);
    throw err;
  }
  const { header, body, bodyLine } = parts;

  for (const key of Object.keys(header)) {
    if (!KEYS.includes(key)) fail(2, `unknown header key '${key}'`);
  }
  const folder = path.basename(dirName);
  if (typeof header.name !== "string" || !NAME_RE.test(header.name)) {
    fail(2, "name is required and must match ^[a-z][a-z0-9-]{0,63}$");
  }
  if (header.name !== folder) fail(2, `name '${header.name}' must equal the folder name '${folder}'`);
  if (header.description !== undefined && typeof header.description !== "string") fail(2, "description must be a string");
  if (header.extends !== undefined && (typeof header.extends !== "string" || !NAME_RE.test(header.extends))) {
    fail(2, "extends must be a type name");
  }
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (header[key] !== undefined && !allowed.includes(header[key])) {
      fail(2, `${key} must be one of: ${allowed.join(", ")}`);
    }
  }
  if (header.coordinator !== undefined && typeof header.coordinator !== "boolean") {
    fail(2, "coordinator must be true or false");
  }
  if (header.requires !== undefined &&
      (!Array.isArray(header.requires) || !header.requires.every((r) => REQUIRES.includes(r)))) {
    fail(2, `requires must be a list with only: ${REQUIRES.join(", ")}`);
  }
  let fields = {};
  if (header.fields !== undefined) {
    if (!isMapping(header.fields)) fail(2, "fields must be a mapping");
    fields = header.fields;
    for (const [name, decl] of Object.entries(fields)) {
      const errors = checkDeclaration(name, decl);
      if (errors.length) fail(2, errors[0]);
    }
  }
  try {
    parseTemplate(body);
  } catch (err) {
    if (err instanceof TemplateError) fail(err.line ? bodyLine + err.line - 1 : bodyLine, err.message);
    throw err;
  }

  const type = { name: header.name, fields, body, bodyLine, file, dir: dirName };
  for (const key of ["description", "extends", "session", "workspace", "outcome", "coordinator", "requires"]) {
    if (header[key] !== undefined) type[key] = header[key];
  }
  return type;
}

// File line of the first use of a placeholder in a type's own body.
function lineOf(type, name) {
  const escaped = name.replace(/\./g, "\\.");
  const re = new RegExp(`\\{\\{[#^/]?${escaped}\\}\\}`);
  const lines = type.body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return type.bodyLine + i;
  }
  return type.bodyLine;
}

function resolveTypes(types) {
  const resolved = {};

  // Returns [root, ..., type].
  function chain(start) {
    const out = [];
    const seen = [];
    let cur = types[start];
    for (;;) {
      seen.push(cur.name);
      out.unshift(cur);
      if (cur.extends === undefined) return out;
      const parent = types[cur.extends];
      if (!parent) throw new NodeTypeError(cur.file, 2, `extends '${cur.extends}': no such node type`);
      const at = seen.indexOf(parent.name);
      if (at >= 0) {
        throw new NodeTypeError(cur.file, 2, `extends loop: ${[...seen.slice(at), parent.name].join(" -> ")}`);
      }
      cur = parent;
    }
  }

  for (const name of Object.keys(types)) {
    const list = chain(name);
    const root = list[0];
    for (const key of ["session", "workspace", "outcome"]) {
      if (root[key] === undefined) throw new NodeTypeError(root.file, 2, `root type '${root.name}' must set ${key}`);
    }
    const own = types[name];
    const out = {
      name: own.name, description: own.description, file: own.file, dir: own.dir, bodyLine: own.bodyLine,
      fields: {}, body: "",
    };
    if (own.extends !== undefined) out.extends = own.extends;
    let body = null;
    for (const t of list) {
      for (const key of ["session", "workspace", "outcome", "coordinator", "requires"]) {
        if (t[key] !== undefined) out[key] = t[key];
      }
      for (const [fname, decl] of Object.entries(t.fields)) {
        if (fname in out.fields && !isDeepStrictEqual(out.fields[fname], decl)) {
          throw new NodeTypeError(t.file, 2, `field '${fname}' changes the declaration of a parent type`);
        }
        out.fields[fname] = decl;
      }
      body = body === null ? t.body : `${body.replace(/\n+$/, "")}\n\n${t.body}`;
    }
    out.body = body;
    if (out.coordinator === undefined) out.coordinator = false;
    if (out.requires === undefined) out.requires = [];
    out.chain = list.map((t) => t.name);

    // Check each body of the chain against the merged fields.
    for (const t of list) {
      const { vars, varSections } = placeholders(t.body);
      for (const v of vars) {
        if (isRouterVariable(v)) continue;
        if (!(v in out.fields)) {
          throw new NodeTypeError(t.file, lineOf(t, v), `declare field \`${v}\` in NODE.md fields`);
        }
        const problem = checkOptionalUse(v, out.fields[v], varSections.get(v));
        if (problem) throw new NodeTypeError(t.file, lineOf(t, v), problem);
      }
    }
    resolved[name] = out;
  }
  return resolved;
}

module.exports = { loadNodeType, resolveTypes };
