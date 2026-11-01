"use strict";

const YAML = require("yaml");

class FormatError extends Error {
  constructor(file, line, message) {
    super(message);
    this.name = "FormatError";
    this.file = file;
    this.line = line;
  }
}

function yamlLine(err, offset) {
  const pos = Array.isArray(err.linePos) ? err.linePos[0] : null;
  return (pos && pos.line ? pos.line : 1) + offset;
}

// Parse YAML text. offset is the number of file lines before the text.
function parseYaml(text, fileName, offset) {
  let doc;
  try {
    doc = YAML.parseDocument(text, { prettyErrors: true });
  } catch (err) {
    throw new FormatError(fileName, yamlLine(err, offset), err.message);
  }
  if (doc.errors.length > 0) {
    const err = doc.errors[0];
    throw new FormatError(fileName, yamlLine(err, offset), err.message);
  }
  return doc.toJS();
}

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Split "---\nheader\n---\nbody" into the parsed header and the body text.
function splitFrontmatter(text, fileName) {
  const lines = String(text).split("\n");
  const isFence = (line) => line.replace(/\r$/, "") === "---";
  if (!isFence(lines[0])) {
    throw new FormatError(fileName, 1, "The file must start with a line '---'");
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (isFence(lines[i])) { end = i; break; }
  }
  if (end < 0) {
    throw new FormatError(fileName, 1, "The header has no closing line '---'");
  }
  const header = parseYaml(lines.slice(1, end).map((l) => l.replace(/\r$/, "")).join("\n"), fileName, 1);
  if (!isMapping(header)) {
    throw new FormatError(fileName, 2, "The header must be a YAML mapping");
  }
  return { header, body: lines.slice(end + 1).join("\n"), bodyLine: end + 2 };
}

// Parse a whole YAML file.
function parseYamlFile(text, fileName) {
  return parseYaml(String(text), fileName, 0);
}

module.exports = { FormatError, splitFrontmatter, parseYamlFile };
