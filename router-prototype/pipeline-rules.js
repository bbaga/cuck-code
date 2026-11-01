"use strict";

// Pipeline rules R1-R10. Pure: no file reads. Runs every rule and returns
// a list of { rule, message }. An empty list means the pipeline is good.

const { placeholders, TemplateError } = require("./template");
const { checkDeclaration, checkOptionalUse, isRouterVariable } = require("./fields");

function has(obj, key) {
  return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

function buildContext(pipeline, types, interactions) {
  const nodes = pipeline.nodes || {};
  const edges = (pipeline.edges || []).map((edge, index) => ({ ...edge, index }));
  const typeOf = (id) => (has(nodes, id) && has(types, nodes[id].type) ? types[nodes[id].type] : undefined);
  const inter = (name) => (has(interactions, name) ? interactions[name] : undefined);
  const known = (id) => has(nodes, id);

  // Edges between known nodes that carry at least one known interaction
  // matching the filter. `list` holds those interactions.
  const withInteractions = (filter) => {
    const out = [];
    for (const edge of edges) {
      if (!known(edge.from) || !known(edge.to)) continue;
      const list = (edge.interactions || []).map(inter).filter((i) => i && filter(i));
      if (list.length) out.push({ ...edge, list });
    }
    return out;
  };
  const createEdges = withInteractions((i) => i.effect === "create");
  const completeEdges = withInteractions((i) => i.trigger === "complete");
  // starters[node] = nodes that can start it through create edges.
  const starters = {};
  for (const id of Object.keys(nodes)) starters[id] = [];
  for (const e of createEdges) if (!starters[e.to].includes(e.from)) starters[e.to].push(e.from);

  return {
    types, pipeline, nodes, edges, typeOf, inter, known,
    withInteractions, createEdges, completeEdges, starters, start: pipeline.start,
  };
}

function ruleR1(c) {
  if (typeof c.start !== "string" || !c.known(c.start)) {
    return [{ rule: "R1", message: `start node '${c.start}' does not exist in nodes` }];
  }
  return [];
}

function reachable(c) {
  const seen = new Set([c.start]);
  const queue = [c.start];
  while (queue.length) {
    const cur = queue.shift();
    for (const e of c.createEdges) {
      if (e.from === cur && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
    }
  }
  return seen;
}

function ruleR2(c) {
  if (!c.known(c.start)) return [];
  const seen = reachable(c);
  return Object.keys(c.nodes).filter((id) => !seen.has(id)).map((id) => ({
    rule: "R2",
    message: `node '${id}' cannot be reached from start node '${c.start}' through create interactions`,
  }));
}

function ruleR3(c) {
  const out = [];
  const next = {};
  for (const e of c.createEdges) (next[e.from] = next[e.from] || []).push(e.to);
  const state = {}; // 1 = on path, 2 = done
  const path = [];
  const seenCycles = new Set();
  const visit = (id) => {
    state[id] = 1;
    path.push(id);
    for (const to of next[id] || []) {
      if (state[to] === 1) {
        const cycle = path.slice(path.indexOf(to));
        const key = [...cycle].sort().join("\0");
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          out.push({ rule: "R3", message: `create edges form a cycle: ${[...cycle, to].join(" -> ")}` });
        }
      } else if (state[to] === undefined) visit(to);
    }
    path.pop();
    state[id] = 2;
  };
  for (const id of Object.keys(c.nodes)) if (state[id] === undefined) visit(id);
  return out;
}

// Nodes a complete-triggered edge from `id` leads to. Target `starter`
// means the nodes that start `id` through create edges.
function completeNext(c, id) {
  const out = [];
  for (const e of c.completeEdges) {
    if (e.from !== id) continue;
    for (const i of e.list.filter((x) => x.trigger === "complete")) {
      const targets = i.target === "starter" ? c.starters[id] : [e.to];
      for (const t of targets) if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

function ruleR4(c) {
  if (!c.known(c.start)) return [];
  const out = [];
  const seen = reachable(c);
  // Returns null when every path from id ends at the start node, else a reason.
  const check = (id, onPath) => {
    if (id === c.start) return null;
    if (onPath.includes(id)) return `the complete path loops: ${[...onPath.slice(onPath.indexOf(id)), id].join(" -> ")}`;
    const next = completeNext(c, id);
    if (next.length === 0) return `the path ends at '${id}', which has no complete-triggered interaction to a node`;
    for (const n of next) {
      const reason = check(n, [...onPath, id]);
      if (reason) return reason;
    }
    return null;
  };
  for (const id of Object.keys(c.nodes)) {
    if (id === c.start || !seen.has(id)) continue; // unreachable nodes: see R2
    const reason = check(id, []);
    if (reason) out.push({ rule: "R4", message: `the result of node '${id}' can get lost: ${reason}` });
  }
  return out;
}

function ruleR5(c) {
  if (!c.known(c.start)) return [];
  const out = [];
  for (const e of c.withInteractions((i) => i.trigger === "request")) {
    if (e.from === c.start) continue;
    const names = e.list.filter((i) => i.trigger === "request").map((i) => i.name);
    out.push({
      rule: "R5",
      message: `edge ${e.from} -> ${e.to}: request-triggered interaction ${names.join(", ")} is allowed only from the start node '${c.start}'`,
    });
  }
  return out;
}

function ruleR6(c) {
  const out = [];
  for (const e of c.withInteractions((i) => i.effect === "deliver")) {
    for (const i of e.list.filter((x) => x.effect === "deliver")) {
      const targets = i.target === "starter" ? c.starters[e.from] : [e.to];
      for (const t of targets) {
        const type = c.typeOf(t);
        if (type && type.session !== "resume") {
          out.push({
            rule: "R6",
            message: `edge ${e.from} -> ${e.to}: deliver interaction '${i.name}' needs a target with session: resume, but node '${t}' has type '${c.nodes[t].type}' with session: ${type.session}`,
          });
        }
      }
    }
  }
  return out;
}

function ruleR7(c) {
  const out = [];
  const checkPrompt = (text, where, nodeFields, typeFields) => {
    if (typeof text !== "string") return;
    let found;
    try {
      found = placeholders(text);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      out.push({ rule: "R7", message: `${where}: ${err.message}` });
      return;
    }
    for (const v of found.vars) {
      if (isRouterVariable(v)) continue;
      const decl = has(nodeFields, v) ? nodeFields[v] : has(typeFields, v) ? typeFields[v] : undefined;
      if (!decl) {
        out.push({ rule: "R7", message: `${where}: declare caller field '${v}' in the node fields or the node type fields` });
        continue;
      }
      const problem = checkOptionalUse(v, decl, found.varSections.get(v));
      if (problem) out.push({ rule: "R7", message: `${where}: ${problem}` });
    }
  };
  const defaultsPrompt = c.pipeline.defaults && c.pipeline.defaults.prompt;
  for (const [id, node] of Object.entries(c.nodes)) {
    const nodeFields = node.fields || {};
    const typeFields = (c.typeOf(id) || {}).fields || {};
    for (const [name, decl] of Object.entries(nodeFields)) {
      for (const m of checkDeclaration(name, decl)) out.push({ rule: "R7", message: `node '${id}': ${m}` });
    }
    checkPrompt(defaultsPrompt, `defaults prompt (for node '${id}')`, nodeFields, typeFields);
    checkPrompt(node.prompt, `prompt of node '${id}'`, nodeFields, typeFields);
  }
  return out;
}

function ruleR8(c) {
  const out = [];
  const add = (message) => out.push({ rule: "R8", message });
  for (const [id, node] of Object.entries(c.nodes)) {
    if (!has(c.types, node.type)) add(`node '${id}': unknown node type '${node.type}'`);
    for (const target of node.checks || []) {
      if (!c.known(target)) add(`node '${id}': checks lists unknown node '${target}'`);
    }
  }
  const pairs = new Set();
  for (const e of c.edges) {
    const label = `edge ${e.from} -> ${e.to}`;
    for (const side of [e.from, e.to]) if (!c.known(side)) add(`${label}: unknown node '${side}'`);
    for (const name of e.interactions || []) if (!c.inter(name)) add(`${label}: unknown interaction '${name}'`);
    const key = `${e.from}\0${e.to}`;
    if (pairs.has(key)) add(`${label}: duplicate edge`);
    pairs.add(key);
  }
  return out;
}

function ruleR9(c) {
  const out = [];
  for (const [id, node] of Object.entries(c.nodes)) {
    if (!Array.isArray(node.checks) || node.checks.length === 0) continue;
    const type = c.typeOf(id);
    if (type && type.workspace !== "source") {
      out.push({ rule: "R9", message: `node '${id}' has checks, so its type '${node.type}' needs workspace: source (has ${type.workspace})` });
    }
    for (const target of node.checks) {
      const t = c.typeOf(target);
      if (t && t.workspace !== "own-worktree") {
        out.push({ rule: "R9", message: `node '${id}' checks '${target}', whose type '${c.nodes[target].type}' needs workspace: own-worktree (has ${t.workspace})` });
      }
    }
  }
  return out;
}

function ruleR10(c) {
  const out = [];
  for (const e of c.completeEdges) {
    for (const i of e.list.filter((x) => x.trigger === "complete" && x.effect === "create")) {
      out.push({
        rule: "R10",
        message: `edge ${e.from} -> ${e.to}: interaction '${i.name}' has trigger complete and effect create: a complete-triggered interaction cannot create an instance`,
      });
    }
  }
  return out;
}

const RULES = [ruleR1, ruleR2, ruleR3, ruleR4, ruleR5, ruleR6, ruleR7, ruleR8, ruleR9, ruleR10];

function checkPipeline(pipeline, types, interactions) {
  const c = buildContext(pipeline, types || {}, interactions || {});
  return RULES.flatMap((rule) => rule(c));
}

module.exports = { checkPipeline };
