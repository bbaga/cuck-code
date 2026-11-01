"use strict";

// Build the prompt of one node from a resolved pipeline (task B4).
// Pure: no file reads. Router values come from the router, caller values
// from the request that starts the node.

const { render, TASK_MARKER, TASK_MARKER_LINE } = require("./template");
const { isRouterVariable } = require("./fields");

function has(obj, key) {
  return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// The protocol markers of a type body are for later tasks. They are not part of the text.
const PROTOCOL_MARKER = /<!-- protocol:(?:start|end) -->\n?/g;

// The task marker (see template.js) splits a type body into the role part
// (before) and the task part (after). A prompt has at most one marker.

// Render the pieces of the prompt: the parts in order, each rendered and
// cleaned. The marker stays in the rendered text.
function renderParts(resolved, nodeId, routerValues, callerValues) {
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
  const rendered = [type.body, resolved.defaults && resolved.defaults.prompt, node.prompt]
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => typeof p === "string" && p.trim() !== "")
    .map(({ p, i }) => ({ i, text: render(p, values, { keepTaskMarker: true }).replace(PROTOCOL_MARKER, "").replace(/\n+$/, "") }))
    .filter(({ text }) => text !== "");
  // The marker may only sit in the type body (parent and child bodies are
  // already joined). Exactly one marker overall is allowed; zero is allowed.
  let count = 0;
  for (const { text } of rendered) count += text.split(TASK_MARKER).length - 1;
  if (count > 1) throw new Error(`node '${nodeId}': the prompt has ${count} '${TASK_MARKER}' markers: use at most one`);
  return rendered;
}

// The full prompt text, with the task marker removed.
function buildPrompt(resolved, nodeId, routerValues, callerValues) {
  return renderParts(resolved, nodeId, routerValues, callerValues)
    .map(({ text }) => text).join("\n\n").replace(TASK_MARKER_LINE, "");
}

// The prompt in two parts: { role, task }. The role part is the text before
// the task marker plus the pipeline and node prompt extensions. The task part
// is the text after the marker. A type without a marker has role "" and the
// whole prompt as task. role + task is NOT the full prompt (the extensions
// sit between them); a harness without a trusted system channel must send the
// full prompt from buildPrompt.
function buildPromptParts(resolved, nodeId, routerValues, callerValues) {
  const rendered = renderParts(resolved, nodeId, routerValues, callerValues);
  const typeText = rendered.length > 0 && rendered[0].i === 0 ? rendered[0].text : "";
  const at = typeText.indexOf(TASK_MARKER);
  if (at < 0) {
    return { role: "", task: rendered.map(({ text }) => text).join("\n\n") };
  }
  const before = typeText.slice(0, at).replace(/\n+$/, "");
  const after = typeText.slice(at + TASK_MARKER.length).replace(/^\n+/, "");
  const extensions = rendered.filter(({ i }) => i !== 0).map(({ text }) => text.replace(TASK_MARKER_LINE, ""));
  return { role: [before, ...extensions].filter((t) => t !== "").join("\n\n"), task: after };
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

module.exports = { buildPrompt, buildPromptParts, workerRouterValues, validatorRouterValues, integrationRouterValues,
  plannerRouterValues };
