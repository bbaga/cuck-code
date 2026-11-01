"use strict";

// Clone sources that the router accepts. Local paths and file:// URLs need an
// explicit opt-in: they let a caller copy any local repository into a line.
function cloneSourceError(url, { allowLocal = false } = {}) {
  if (/^(https|ssh):\/\//i.test(url)) return null;
  if (/^[\w.-]+@[\w.-]+:/.test(url)) return null;
  if (allowLocal && !url.startsWith("-")) return null;
  return "repo URL must use https://, ssh://, or user@host:path";
}

module.exports = { cloneSourceError };
