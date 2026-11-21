"use strict";

// Pipeline rules R1-R18. Pure: no file reads. Runs every rule and returns
// a list of { rule, message }. An empty list means the pipeline is good.

const { placeholders, TemplateError } = require("./template");
const { graphRelations } = require("./graph-relations");
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

  const isRework = (i) => i.trigger === "complete" && i.effect === "deliver" && i.target === "source";
  const isHandoff = (i) => i.trigger === "complete" && i.effect === "create";
  const isArrive = (i) => i.effect === "arrive";
  const handoffEdges = withInteractions(isHandoff);
  const reworkEdges = withInteractions(isRework);
  const arriveEdges = withInteractions(isArrive);

  // The nodes that start `id` through request-triggered create edges. A node
  // without such a starter takes the starters of the nodes that reach it
  // through complete-create or arrive edges.
  const requestStartersCache = {};
  const requestStarters = (id, onPath = []) => {
    if (has(requestStartersCache, id)) return requestStartersCache[id];
    const direct = [];
    for (const e of createEdges) {
      if (e.to !== id || !e.list.some((i) => i.trigger === "request")) continue;
      if (!direct.includes(e.from)) direct.push(e.from);
    }
    let out = direct;
    if (direct.length === 0 && !onPath.includes(id)) {
      out = [];
      for (const e of [...handoffEdges, ...arriveEdges]) {
        if (e.to !== id) continue;
        for (const s of requestStarters(e.from, [...onPath, id])) if (!out.includes(s)) out.push(s);
      }
    }
    if (onPath.length === 0) requestStartersCache[id] = out;
    return out;
  };
  const isWait = (id) => (typeOf(id) || {}).runner === "wait";
  // The stage of a node: the targets of its complete-create edges.
  const stageOf = (id) => [...new Set(handoffEdges.filter((e) => e.from === id).map((e) => e.to))];

  return {
    types, interactions, pipeline, nodes, edges, typeOf, inter, known,
    withInteractions, createEdges, completeEdges, starters, start: pipeline.start,
    isRework, isHandoff, isArrive, handoffEdges, reworkEdges, arriveEdges, requestStarters, isWait, stageOf,
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
// means the nodes that start `id` through request-triggered create edges.
// Rework edges are ignored: they send a task back, not forward.
function completeNext(c, id) {
  const out = [];
  for (const e of c.completeEdges) {
    if (e.from !== id) continue;
    for (const i of e.list.filter((x) => x.trigger === "complete" && !c.isRework(x))) {
      const targets = i.target === "starter" ? c.requestStarters(id) : [e.to];
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
  // A fallback interaction that reaches the start node always gives the result back.
  const hasFallbackToStart = (id) => c.completeEdges.some((e) => e.from === id && e.list.some((i) => (
    i.trigger === "complete" && i.fallback === true
    && (i.target === "starter" ? c.requestStarters(id) : [e.to]).includes(c.start))));
  for (const id of Object.keys(c.nodes)) {
    if (id === c.start || !seen.has(id)) continue; // unreachable nodes: see R2
    if (hasFallbackToStart(id)) continue;
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
      const targets = i.target === "starter" ? c.requestStarters(e.from) : [e.to];
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

// R10: a complete-triggered create starts a checker or an integration node only.
function ruleR10(c) {
  const out = [];
  for (const e of c.handoffEdges) {
    const type = c.typeOf(e.to);
    if (type && (type.workspace === "source" || type.workspace === "integration")) continue;
    for (const i of e.list.filter(c.isHandoff)) {
      out.push({
        rule: "R10",
        message: `edge ${e.from} -> ${e.to}: interaction '${i.name}' has trigger complete and effect create, so node '${e.to}' needs a type with workspace source or integration`,
      });
    }
  }
  return out;
}

// R11: a node of a type with runner script runs scripts and no agent; any
// other node sets no script keys.
function ruleR11(c) {
  const out = [];
  const add = (message) => out.push({ rule: "R11", message });
  for (const [id, node] of Object.entries(c.nodes)) {
    const type = c.typeOf(id);
    if (!type) continue;
    if (type.runner === "script") {
      if (!Array.isArray(node.scripts) || node.scripts.length === 0) {
        add(`node '${id}': type '${node.type}' runs scripts, so the node needs scripts (at least 1)`);
      }
      if (!Array.isArray(node.checks) || node.checks.length === 0) {
        add(`node '${id}': a script node needs a non-empty checks list`);
      }
      for (const key of ["harness", "model", "effort", "maxContext", "prompt", "fields"]) {
        if (key in node) add(`node '${id}': a script node cannot set ${key}: no agent runs`);
      }
      const root = type.chain && type.chain[0];
      if (root !== "script-check") {
        add(`node '${id}': the root of type '${node.type}' must be script-check (is ${root})`);
      }
    } else {
      for (const key of ["scripts", "failFast", "required", "checkout"]) {
        if (key in node) add(`node '${id}': ${key} needs a node type with runner: script (type '${node.type}' runs an agent)`);
      }
    }
  }
  return out;
}

// R12: after lists nodes that check the same target as this node.
function ruleR12(c) {
  const out = [];
  const add = (message) => out.push({ rule: "R12", message });
  for (const [id, node] of Object.entries(c.nodes)) {
    if (!Array.isArray(node.after)) continue;
    const checks = node.checks || [];
    if (checks.length === 0) add(`node '${id}': after needs a non-empty checks list`);
    for (const other of node.after) {
      if (other === id) { add(`node '${id}': after lists the node itself`); continue; }
      if (!c.known(other)) { add(`node '${id}': after lists unknown node '${other}'`); continue; }
      const shared = (c.nodes[other].checks || []).some((t) => checks.includes(t));
      if (!shared) add(`node '${id}': after lists '${other}', which checks no target that '${id}' checks`);
    }
  }
  return out;
}

// R13: the ordering relations form no loop.
function ruleR13(c) {
  const graph = { start: c.start, nodes: c.nodes, edges: c.pipeline.edges || [], interactions: c.interactions, types: c.types };
  const { cycle, cycleCauses } = graphRelations(graph);
  if (!cycle) return [];
  return [{ rule: "R13", message: `ordering relations form a loop: ${cycle.join(" -> ")} (${cycleCauses.join("; ")})` }];
}

// R17: the start node has a type that extends planner. No other node has one.
function ruleR17(c) {
  const out = [];
  // The root of the type chain; a type without a chain is its own root.
  const rootOf = (type, name) => (type && type.chain && type.chain.length ? type.chain[0] : name);
  const startNode = c.known(c.start) ? c.nodes[c.start] : undefined;
  const startType = c.typeOf(c.start);
  if (startNode && startType && rootOf(startType, startNode.type) !== "planner") {
    out.push({ rule: "R17", message: `start node '${c.start}' must have a type that extends planner (has '${startNode.type}')` });
  }
  if (!startNode) return out; // R1 reports a missing start node
  for (const [id, node] of Object.entries(c.nodes)) {
    if (id === c.start) continue;
    if (rootOf(c.typeOf(id), node.type) === "planner") {
      out.push({ rule: "R17", message: `node '${id}': type '${node.type}' extends planner, which only the start node can use` });
    }
  }
  return out;
}

// R14: the shape of a handoff (a complete-triggered create edge).
function ruleR14(c) {
  const out = [];
  const add = (message) => out.push({ rule: "R14", message });
  for (const e of c.handoffEdges) {
    const type = c.typeOf(e.to);
    const label = `edge ${e.from} -> ${e.to}`;
    if (type && type.workspace === "source") {
      const toChecks = c.nodes[e.to].checks || [];
      const fromChecks = c.nodes[e.from].checks || [];
      if (!toChecks.includes(e.from) && !fromChecks.some((t) => toChecks.includes(t))) {
        add(`${label}: node '${e.to}' must check '${e.from}', or check a node that '${e.from}' checks`);
      }
    }
    if (type && type.workspace === "integration" && !c.isWait(e.from)) {
      add(`${label}: only a wait node can start the integration node '${e.to}' with a handoff`);
    }
  }
  for (const e of c.arriveEdges) {
    if (c.handoffEdges.some((h) => h.from === e.from)) {
      add(`node '${e.from}' has an arrive edge, so it cannot also have a complete-triggered create edge`);
    }
  }
  for (const id of Object.keys(c.nodes)) {
    if (c.isWait(id) && c.stageOf(id).length > 1) {
      add(`wait node '${id}' has ${c.stageOf(id).length} complete-triggered create edges: at most 1 is allowed`);
    }
  }
  return out;
}

// R15: the shape of a rework edge, and where maxRounds is allowed.
function ruleR15(c) {
  const out = [];
  for (const e of c.reworkEdges) {
    if (!(c.nodes[e.from].checks || []).includes(e.to)) {
      out.push({ rule: "R15", message: `edge ${e.from} -> ${e.to}: a rework edge needs node '${e.to}' in the checks of '${e.from}'` });
    }
  }
  for (const [id, node] of Object.entries(c.nodes)) {
    if ("maxRounds" in node && !c.reworkEdges.some((e) => e.from === id)) {
      out.push({ rule: "R15", message: `node '${id}': maxRounds needs an outgoing rework edge` });
    }
  }
  return out;
}

const WAIT_FORBIDDEN_KEYS = ["checks", "after", "scripts", "failFast", "required", "checkout", "harness", "model",
  "effort", "maxContext", "prompt", "fields", "maxRounds"];

// R16: the shape of arrive edges and wait nodes.
function ruleR16(c) {
  const out = [];
  const add = (message) => out.push({ rule: "R16", message });
  for (const e of c.arriveEdges) {
    const label = `edge ${e.from} -> ${e.to}`;
    if (!c.isWait(e.to)) add(`${label}: an arrive edge needs a target node with a type with runner wait`);
    const from = c.typeOf(e.from);
    const hasChecks = (c.nodes[e.from].checks || []).length > 0;
    if (!hasChecks && !(from && from.workspace === "own-worktree")) {
      add(`${label}: an arrive edge needs a source node with checks, or with a type with workspace own-worktree`);
    }
  }
  for (const id of Object.keys(c.nodes)) {
    if (!c.isWait(id)) continue;
    for (const key of WAIT_FORBIDDEN_KEYS) {
      if (key in c.nodes[id]) add(`node '${id}': a wait node cannot set ${key}`);
    }
    for (const e of c.handoffEdges.filter((h) => h.from === id)) {
      const type = c.typeOf(e.to);
      if (type && type.workspace !== "integration") {
        add(`edge ${id} -> ${e.to}: a wait node can start only nodes with workspace integration`);
      }
    }
  }
  return out;
}

// R18: the members of one stage (the targets of the handoffs of one node).
function ruleR18(c) {
  const out = [];
  const add = (message) => out.push({ rule: "R18", message });
  for (const from of Object.keys(c.nodes)) {
    const stage = c.stageOf(from);
    if (stage.length < 2) continue;
    const next = (id) => JSON.stringify([
      c.stageOf(id).sort(),
      [...new Set(c.arriveEdges.filter((e) => e.from === id).map((e) => e.to))].sort(),
    ]);
    const first = next(stage[0]);
    for (const id of stage.slice(1)) {
      if (next(id) !== first) {
        add(`stage of '${from}': members '${stage[0]}' and '${id}' have different next targets (handoff and arrive)`);
      }
    }
    for (const id of stage) {
      const type = c.typeOf(id);
      if (type && type.runner === "script" && c.nodes[id].checkout !== "clean") {
        add(`stage of '${from}': script node '${id}' needs checkout: clean, because the stage has ${stage.length} members`);
      }
      for (const other of c.nodes[id].after || []) {
        if (other !== id && stage.includes(other)) {
          add(`stage of '${from}': member '${id}' lists member '${other}' in after`);
        }
      }
    }
  }
  return out;
}

const RULES = [ruleR1, ruleR2, ruleR3, ruleR4, ruleR5, ruleR6, ruleR7, ruleR8, ruleR9, ruleR10, ruleR11, ruleR12, ruleR13, ruleR14, ruleR15, ruleR16, ruleR17, ruleR18];

function checkPipeline(pipeline, types, interactions) {
  const c = buildContext(pipeline, types || {}, interactions || {});
  return RULES.flatMap((rule) => rule(c));
}

module.exports = { checkPipeline };
