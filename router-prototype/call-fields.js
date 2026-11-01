"use strict";

// Required fields of a request-triggered call. Pure: no file reads.
// `resolved` is the output of resolvePipelineDefinition (A10).

const { isDeepStrictEqual } = require("node:util");
const { placeholders } = require("./template");
const { checkValues, isRouterVariable } = require("./fields");

function has(obj, key) {
  return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

// Caller placeholders of a template: not router variables, and not names a
// router list section sets (a section over a router variable).
function callerVars(text) {
  if (typeof text !== "string" || text === "") return [];
  const { vars, varSections } = placeholders(text);
  const out = [];
  for (const v of vars) {
    if (isRouterVariable(v)) continue;
    if ((varSections.get(v) || []).some(isRouterVariable)) continue;
    out.push(v);
  }
  return out;
}

function requiredFields(resolved, interactionName, toNodeId) {
  if (!resolved || !has(resolved.interactions, interactionName)) {
    throw new Error(`unknown interaction '${interactionName}'`);
  }
  if (!has(resolved.nodes, toNodeId)) throw new Error(`unknown node '${toNodeId}'`);
  const interaction = resolved.interactions[interactionName];
  const node = resolved.nodes[toNodeId];
  const type = has(resolved.types, node.type) ? resolved.types[node.type] : undefined;
  if (!type) throw new Error(`node '${toNodeId}': unknown node type '${node.type}'`);

  const map = {};
  const add = (field, decl, requiredBy) => {
    if (has(map, field)) {
      if (!isDeepStrictEqual(map[field].decl, decl)) {
        throw new Error(
          `field '${field}' is declared in different ways by ${map[field].requiredBy} and ${requiredBy} ` +
          `(call '${interactionName}' to node '${toNodeId}')`);
      }
      return;
    }
    map[field] = { decl, requiredBy };
  };
  const undeclared = (field, where) => new Error(`${where}: caller field '${field}' is not declared`);

  // 1. Caller variables of the interaction body.
  for (const v of callerVars(interaction.body)) {
    if (!has(interaction.fields, v)) throw undeclared(v, `interaction '${interactionName}'`);
    add(v, interaction.fields[v], `interaction ${interactionName}`);
  }
  // Declared fields that the body does not use (for example the reason of 'accept') are still part
  // of the call. The 'instance' field of a 'chosen' target comes from the effect step below.
  for (const [name, decl] of Object.entries(interaction.fields || {})) {
    if (name === "instance" && interaction.target === "chosen") continue;
    add(name, decl, `interaction ${interactionName}`);
  }

  if (interaction.effect === "create") {
    // 2. Everything the new instance's prompt is built from.
    const nodeFields = node.fields || {};
    const typeFields = type.fields || {};
    const declOf = (v, where) => {
      const inNode = has(nodeFields, v);
      const inType = has(typeFields, v);
      if (inNode && inType && !isDeepStrictEqual(nodeFields[v], typeFields[v])) {
        throw new Error(`field '${v}' is declared in different ways by pipeline node ${toNodeId} and node type ${node.type}`);
      }
      if (inNode) return nodeFields[v];
      if (inType) return typeFields[v];
      throw undeclared(v, where);
    };
    for (const v of callerVars(type.body)) add(v, declOf(v, `node type '${type.name}'`), `node type ${node.type}`);
    const defaults = resolved.defaults && resolved.defaults.prompt;
    for (const v of callerVars(defaults)) add(v, declOf(v, "defaults prompt"), "pipeline defaults");
    for (const v of callerVars(node.prompt)) add(v, declOf(v, `prompt of node '${toNodeId}'`), `pipeline node ${toNodeId}`);
  }

  // 3. Effect fields.
  if (interaction.target === "chosen") {
    add("instance", { description: `The instance of node '${toNodeId}' that receives the message.`, type: "instance", node: toNodeId },
      "target: chosen");
  }
  if (interaction.effect === "create") {
    if (type.workspace === "own-worktree") {
      add("repo", { description: "The registered repository the new instance works in.", type: "repo" }, "workspace: own-worktree");
      add("base", { description: "Start point of the worktree: a commit.", type: "string", optional: true }, "workspace: own-worktree");
    } else if (type.workspace === "source") {
      const checks = Array.isArray(node.checks) ? node.checks : [];
      const decl = { description: "The instance whose work this node checks.", type: "instance" };
      if (checks.length === 1) decl.node = checks[0];
      else if (checks.length > 1) decl.node = checks.slice();
      add("source", decl, "workspace: source");
    }
    add("name", { description: "Optional name of the new instance.", type: "string", optional: true }, "effect: create");
  }
  return map;
}

function describe(decl) {
  let kind = decl.type;
  if (decl.type === "instance" && decl.node !== undefined) {
    kind += ` of ${Array.isArray(decl.node) ? decl.node.join(" or ") : decl.node}`;
  }
  if (decl.type === "enum" && Array.isArray(decl.values)) kind += ` (${decl.values.join(", ")})`;
  if (decl.pattern !== undefined) kind += ` ${decl.pattern}`;
  return `${kind}, ${decl.optional ? "optional" : "required"}`;
}

function checkCall(resolved, interactionName, toNodeId, body) {
  const declared = requiredFields(resolved, interactionName, toNodeId);
  const { missing, invalid, unexpected } = checkValues(declared, body);
  const expected = {};
  for (const [field, { decl }] of Object.entries(declared)) expected[field] = describe(decl);
  return {
    ok: missing.length === 0 && invalid.length === 0 && unexpected.length === 0,
    missing, invalid, unexpected, expected,
  };
}

// Checks the values of type instance, repo and commit against the line.
// `line` gives the line state through three accessors, so the check stays pure:
//   instance(id) -> { node, status, repo } or undefined (status "running" blocks)
//   hasRepo(name) -> boolean
//   commitExists(repoName, sha) -> boolean
// Returns a list of { field, reason }. Blank and non-string values are left
// to checkValues.
function checkLineValues(line, required, body) {
  const problems = [];
  const src = body !== null && typeof body === "object" ? body : {};
  const given = (field) => typeof src[field] === "string" && src[field].trim() !== "";
  const add = (field, reason) => problems.push({ field, reason });
  // The repo of a call: its 'repo' value, else the repo of a named instance.
  const callRepo = () => {
    if (given("repo")) return src.repo;
    for (const [field, { decl }] of Object.entries(required || {})) {
      if (decl.type !== "instance" || !given(field)) continue;
      const inst = line.instance(src[field]);
      if (inst && inst.repo) return inst.repo;
    }
    return null;
  };
  for (const [field, { decl }] of Object.entries(required || {})) {
    if (!given(field)) continue;
    const value = src[field];
    if (decl.type === "instance") {
      const inst = line.instance(value);
      if (!inst) { add(field, "no such instance on this line"); continue; }
      if (inst.status === "running") { add(field, "the instance is running: wait until its run ends"); continue; }
      if (decl.node !== undefined) {
        const nodes = Array.isArray(decl.node) ? decl.node : [decl.node];
        if (!nodes.includes(inst.node)) add(field, `the instance belongs to node '${inst.node}': expected ${nodes.join(" or ")}`);
      }
    } else if (decl.type === "repo") {
      if (!line.hasRepo(value)) add(field, "not a registered repo of this line");
    } else if (decl.type === "commit") {
      if (!/^[0-9a-f]{40}$/.test(value)) { add(field, "must be 40 lowercase hex characters"); continue; }
      const repo = callRepo();
      if (!repo) add(field, "the repo of the call is unknown: cannot look the commit up");
      else if (!line.commitExists(repo, value)) add(field, `commit not found in repo '${repo}'`);
    }
  }
  return problems;
}

// What the start node may do: { caller, interactions: [{ name, description, effect, target,
// to: [{ node, fields: { field: { description, expected } } }] }] }. Only request-triggered
// interactions with an edge from the start node count. The order follows the edges.
// `fields` comes from requiredFields, the function the router enforces.
function introspect(resolved) {
  const caller = resolved.start;
  const byName = new Map();
  for (const edge of resolved.edges || []) {
    if (edge.from !== caller) continue;
    for (const name of edge.interactions || []) {
      const def = has(resolved.interactions, name) ? resolved.interactions[name] : undefined;
      if (!def || def.trigger !== "request") continue;
      if (!byName.has(name)) {
        byName.set(name, { name, description: def.description, effect: def.effect, target: def.target, to: [] });
      }
      const entry = byName.get(name);
      if (entry.to.some((t) => t.node === edge.to)) continue;
      const fields = {};
      for (const [field, { decl }] of Object.entries(requiredFields(resolved, name, edge.to))) {
        fields[field] = { description: decl.description, expected: describe(decl) };
      }
      entry.to.push({ node: edge.to, fields });
    }
  }
  return { caller, interactions: [...byName.values()] };
}

module.exports = { requiredFields, checkCall, checkLineValues, introspect, describe };
