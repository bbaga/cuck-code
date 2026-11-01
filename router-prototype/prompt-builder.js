"use strict";

// Build the prompt of one node from a resolved pipeline (task B4).
// Pure: no file reads. Router values come from the router, caller values
// from the request that starts the node.

const { render } = require("./template");
const { isRouterVariable } = require("./fields");

function has(obj, key) {
  return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// The protocol markers of a type body are for later tasks. They are not part of the text.
const PROTOCOL_MARKER = /<!-- protocol:(?:start|end) -->\n?/g;

function buildPrompt(resolved, nodeId, routerValues, callerValues) {
  if (!resolved || !has(resolved.nodes, nodeId)) throw new Error(`unknown node '${nodeId}'`);
  const node = resolved.nodes[nodeId];
  const type = has(resolved.types, node.type) ? resolved.types[node.type] : undefined;
  if (!type) throw new Error(`node '${nodeId}': unknown node type '${node.type}'`);

  const caller = callerValues === undefined || callerValues === null ? {} : callerValues;
  if (!isPlainObject(caller)) throw new Error("caller values must be an object");
  const router = routerValues === undefined || routerValues === null ? {} : routerValues;
  const declared = { ...(type.fields || {}), ...(node.fields || {}) };
  for (const name of Object.keys(caller)) {
    if (isRouterVariable(name) || has(router, name)) {
      throw new Error(`caller value '${name}' names a router variable: the router sets it`);
    }
    if (!has(declared, name)) throw new Error(`caller value '${name}' is not a declared field of node '${nodeId}'`);
  }

  const values = { ...caller, ...router };
  const parts = [type.body, resolved.defaults && resolved.defaults.prompt, node.prompt]
    .filter((p) => typeof p === "string" && p.trim() !== "")
    .map((p) => render(p, values).replace(PROTOCOL_MARKER, "").replace(/\n+$/, ""))
    .filter((p) => p !== "");
  return parts.join("\n\n");
}

// Router value builders. Each takes plain data from the router state.

function lineValues(line) {
  return { id: line.id, name: line.name };
}

function routerUrl(port) {
  return { url: `http://localhost:${port}` };
}

function workerRouterValues({ line, nodeId, workerId, workerName, repo, baseCommit, baseNote, port, changesetLimit }) {
  const r = { name: repo.name };
  if (repo.url) r.url = repo.url;
  return {
    line: { ...lineValues(line), changesetLimit: String(changesetLimit) },
    node: { id: nodeId },
    instance: { id: workerId, name: workerName, baseCommit: baseCommit || "unknown", baseNote: baseNote || "" },
    repo: r,
    router: routerUrl(port),
  };
}

function validatorRouterValues({ line, nodeId, workerId, workerName, implementor, report, repoName, repoUrl, port }) {
  const repo = {};
  if (repoName) repo.name = repoName;
  if (repoUrl) repo.url = repoUrl;
  const source = { name: implementor.name, id: implementor.id || "", report };
  return {
    line: lineValues(line),
    node: { id: nodeId },
    instance: { id: workerId, name: workerName },
    source,
    repo,
    router: routerUrl(port),
  };
}

function integrationRouterValues({ line, nodeId, workerId, workerName, manifest, branch, port }) {
  return {
    line: lineValues(line),
    node: { id: nodeId },
    instance: { id: workerId, name: workerName },
    router: routerUrl(port),
    integration: {
      branch,
      repos: manifest.map((r) => ({
        name: r.name, url: r.url, worktreePath: r.worktreePath, baseBranch: r.baseBranch || "HEAD",
        baseSha: r.baseSha, branches: r.branches,
      })),
    },
  };
}

function plannerRouterValues({ line, nodeId, port, workerCap }) {
  return {
    line: lineValues(line),
    node: { id: nodeId },
    router: { ...routerUrl(port), workerCap },
  };
}

module.exports = { buildPrompt, workerRouterValues, validatorRouterValues, integrationRouterValues,
  plannerRouterValues };
