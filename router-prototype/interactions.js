"use strict";

const { splitFrontmatter, FormatError } = require("./frontmatter");
const { parseTemplate, placeholders, TemplateError } = require("./template");
const { checkDeclaration, checkOptionalUse, isRouterVariable } = require("./fields");

const KEYS = ["name", "description", "effect", "trigger", "target", "fields", "when", "fallback"];
const EFFECTS = ["create", "deliver", "accept", "arrive"];
const TRIGGERS = ["request", "complete"];
const TARGETS = ["new", "chosen", "starter", "source", "waiter"];
const OUTCOMES = ["done", "pass", "reject", "missing", "timeout", "failed", "stopped"];
const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Read <dirName>/INTERACTION.md through readFile(path) and check it.
// options.builtIn: true allows effects "accept" and "arrive". Throws FormatError.
function loadInteraction(dirName, readFile, options = {}) {
  const file = `${dirName}/INTERACTION.md`;
  let text;
  try {
    text = readFile(file);
  } catch (err) {
    throw new FormatError(file, 1, `Cannot read ${file}: ${err.message}`);
  }
  const { header, body, bodyLine } = splitFrontmatter(text, file);
  const lines = String(text).split("\n");
  const lineOf = (key) => {
    const i = lines.findIndex((l, n) => n > 0 && l.startsWith(`${key}:`));
    return i < 0 ? 2 : i + 1;
  };
  const fail = (key, message) => { throw new FormatError(file, lineOf(key), message); };

  for (const key of Object.keys(header)) {
    if (!KEYS.includes(key)) fail(key, `Unknown header key '${key}'`);
  }
  const folder = String(dirName).split("/").filter(Boolean).pop();
  if (typeof header.name !== "string" || !NAME_RE.test(header.name)) {
    fail("name", "name is required and must match ^[a-z][a-z0-9-]{0,63}$");
  }
  if (header.name !== folder) fail("name", `name '${header.name}' must equal the folder name '${folder}'`);
  if (typeof header.description !== "string" || header.description.trim() === "") {
    fail("description", "description is required: a non-empty string");
  }
  const oneOf = (key, allowed) => {
    if (!allowed.includes(header[key])) fail(key, `${key} must be one of: ${allowed.join(", ")}`);
  };
  oneOf("effect", EFFECTS);
  oneOf("trigger", TRIGGERS);
  oneOf("target", TARGETS);
  const { effect, trigger, target } = header;

  if (effect === "arrive" && (trigger !== "complete" || target !== "waiter")) {
    fail(trigger !== "complete" ? "trigger" : "target", "effect arrive needs trigger complete and target waiter");
  }
  if (target === "waiter" && effect !== "arrive") fail("target", "target waiter needs effect arrive");

  if (effect === "create" && target !== "new") fail("target", "effect create needs target new");
  if (effect === "deliver" && !["chosen", "starter", "source"].includes(target)) {
    fail("target", "effect deliver needs target chosen, starter or source");
  }
  if (effect === "accept" && target !== "chosen") fail("target", "effect accept needs target chosen");
  if (target === "chosen" && trigger !== "request") fail("trigger", "target chosen needs trigger request");
  if (effect === "accept" && options.builtIn !== true) {
    fail("effect", "effect accept is reserved for built-in interactions");
  }
  if (effect === "arrive" && options.builtIn !== true) {
    fail("effect", "effect arrive is reserved for built-in interactions");
  }

  let when = OUTCOMES.slice();
  if (header.when !== undefined) {
    if (trigger !== "complete") fail("when", "when is allowed only with trigger complete");
    if (!Array.isArray(header.when) || header.when.length === 0 ||
        !header.when.every((o) => OUTCOMES.includes(o)) ||
        new Set(header.when).size !== header.when.length) {
      fail("when", `when must be a non-empty list without duplicates, with only: ${OUTCOMES.join(", ")}`);
    }
    when = header.when.slice();
  }
  if (header.fallback !== undefined) {
    if (trigger !== "complete") fail("fallback", "fallback is allowed only with trigger complete");
    if (typeof header.fallback !== "boolean") fail("fallback", "fallback must be true or false");
  }
  const fallback = header.fallback === true;

  let fields = {};
  if (header.fields !== undefined && header.fields !== null) {
    if (!isPlainObject(header.fields)) fail("fields", "fields must be a mapping");
    fields = header.fields;
    for (const [name, decl] of Object.entries(fields)) {
      const errors = checkDeclaration(name, decl);
      if (errors.length) fail("fields", errors[0]);
    }
  }

  const bodyFail = (message, line) => { throw new FormatError(file, bodyLine + line - 1, message); };
  let found;
  try {
    parseTemplate(body);
    found = placeholders(body);
  } catch (err) {
    if (!(err instanceof TemplateError)) throw err;
    bodyFail(err.message, err.line || 1);
  }
  const lineOfVar = (name) => {
    const idx = body.indexOf(`{{${name}}}`);
    return idx < 0 ? 1 : body.slice(0, idx).split("\n").length;
  };

  if (effect === "accept" || effect === "arrive") {
    if (body.trim() !== "") bodyFail(`An ${effect} interaction must have an empty body`, 1);
  } else if (trigger === "complete") {
    const message = "a complete-triggered interaction has no caller: use router variables only";
    if (Object.keys(fields).length > 0) fail("fields", message);
    for (const name of found.vars) {
      if (!isRouterVariable(name)) bodyFail(`${message} ('${name}')`, lineOfVar(name));
    }
  } else {
    for (const name of found.vars) {
      if (isRouterVariable(name)) continue;
      if (!Object.prototype.hasOwnProperty.call(fields, name)) {
        bodyFail(`declare field \`${name}\` in INTERACTION.md fields`, lineOfVar(name));
      }
      const problem = checkOptionalUse(name, fields[name], found.varSections.get(name));
      if (problem) bodyFail(problem, lineOfVar(name));
    }
  }

  return {
    name: header.name, description: header.description, effect, trigger, target,
    fields, when, fallback, body, bodyLine,
  };
}

module.exports = { loadInteraction };
