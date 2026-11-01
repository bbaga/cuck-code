"use strict";

const ROUTER_VARIABLES = [
  "line.*", "node.*", "instance.*", "from.*",
  "repo.url", "repo.name", "router.url", "router.workerCap",
  "source.name", "source.report", "source.id", "source.harness", "source.session", "report", "outcome", "outcome.*",
  "integration.*", "protocol",
];

const TYPES = ["string", "text", "enum", "commit", "instance", "repo"];
const KEYS = ["description", "type", "maxLength", "pattern", "values", "node", "optional"];
const DEFAULT_MAX = { string: 200, text: 20000 };

function isRouterVariable(name) {
  if (typeof name !== "string") return false;
  return ROUTER_VARIABLES.some((p) => (p.endsWith(".*")
    ? name.startsWith(p.slice(0, -1)) && name.length > p.length - 1
    : name === p));
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function checkDeclaration(name, decl) {
  if (isRouterVariable(name)) return [`field '${name}' is a router variable: the router sets it`];
  if (!isPlainObject(decl)) return [`field '${name}': declaration must be an object`];
  const errors = [];
  const err = (m) => errors.push(`field '${name}': ${m}`);
  for (const key of Object.keys(decl)) if (!KEYS.includes(key)) err(`unknown key '${key}'`);

  const d = decl.description;
  if (typeof d !== "string" || d.length < 1 || d.length > 300) err("description is required: a string of 1 to 300 characters");

  const type = decl.type;
  if (!TYPES.includes(type)) err(`type must be one of ${TYPES.join(", ")}`);

  const only = (key, types) => {
    if (key in decl && TYPES.includes(type) && !types.includes(type)) err(`'${key}' is not allowed for type '${type}'`);
  };
  only("maxLength", ["string", "text"]);
  only("pattern", ["string"]);
  only("values", ["enum"]);
  only("node", ["instance"]);

  if ("maxLength" in decl && (!Number.isInteger(decl.maxLength) || decl.maxLength < 1)) err("maxLength must be a positive integer");
  if ("pattern" in decl) {
    if (typeof decl.pattern !== "string") err("pattern must be a string");
    else {
      try { new RegExp(decl.pattern); } catch { err("pattern is not a valid regular expression"); }
    }
  }
  if (type === "enum" && (!Array.isArray(decl.values) || decl.values.length === 0 || !decl.values.every((v) => typeof v === "string"))) {
    err("values is required: a non-empty list of strings");
  }
  if ("node" in decl && (typeof decl.node !== "string" || decl.node === "")) err("node must be a node id");
  if ("optional" in decl && decl.optional !== true) err("optional must be true or missing");
  return errors;
}

function isBlank(v) {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

function checkOne(decl, value) {
  if (typeof value !== "string") return "must be a string";
  switch (decl.type) {
    case "string": {
      if (/[\r\n]/.test(value)) return "must be one line";
      const max = decl.maxLength ?? DEFAULT_MAX.string;
      if (value.length > max) return `longer than ${max} characters`;
      if (decl.pattern !== undefined && !new RegExp(decl.pattern).test(value)) return `does not match ${decl.pattern}`;
      return null;
    }
    case "text": {
      const max = decl.maxLength ?? DEFAULT_MAX.text;
      return value.length > max ? `longer than ${max} characters` : null;
    }
    case "enum":
      return decl.values.includes(value) ? null : `must be one of: ${decl.values.join(", ")}`;
    default:
      return null; // instance, repo, commit: line checks come later (task C3)
  }
}

function checkValues(declared, body) {
  const missing = [];
  const invalid = [];
  const unexpected = [];
  const decls = declared || {};
  const src = isPlainObject(body) ? body : {};
  for (const [field, { decl, requiredBy }] of Object.entries(decls)) {
    const value = src[field];
    if (isBlank(value)) {
      if (!decl.optional) missing.push({ field, description: decl.description, requiredBy });
      continue;
    }
    const reason = checkOne(decl, value);
    if (reason) invalid.push({ field, reason });
  }
  for (const name of Object.keys(src)) {
    // A router variable is never declared by a caller: "set by the router".
    if (isRouterVariable(name) ||!Object.prototype.hasOwnProperty.call(decls, name)) unexpected.push(name);
  }
  return { missing, invalid, unexpected };
}

function checkOptionalUse(name, decl, sectionsAround) {
  if (!decl || decl.optional !== true) return null;
  if (Array.isArray(sectionsAround) && sectionsAround.includes(name)) return null;
  return `optional field '${name}' may appear only inside {{#${name}}}...{{/${name}}}`;
}

module.exports = { ROUTER_VARIABLES, isRouterVariable, checkDeclaration, checkValues, checkOptionalUse };
