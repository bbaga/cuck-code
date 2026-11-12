"use strict";

// The relations a resolved pipeline declares, and the column and row of each
// node. Pure. The result depends only on the declared relations: node ids,
// type names, phases and roles carry no meaning here.

function has(obj, key) {
  return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

const arr = (v) => (Array.isArray(v) ? v : []);

function declaredRelations(graph) {
  const nodes = graph.nodes || {};
  const types = graph.types || {};
  const interactions = graph.interactions || {};
  const typeOf = (id) => (has(types, nodes[id].type) ? types[nodes[id].type] : {});
  const ids = Object.keys(nodes);
  const ownWorktree = ids.filter((id) => typeOf(id).workspace === "own-worktree");
  const needsWork = ids.filter((id) => arr(typeOf(id).requires).includes("accepted-work"));
  const relations = [];

  for (const edge of arr(graph.edges)) {
    const names = arr(edge.interactions);
    const list = names.map((name) => (has(interactions, name) ? interactions[name] : {}));
    relations.push({
      from: edge.from, to: edge.to, kind: "interaction", label: names.join(", "), interactions: [...names],
      ordering: list.some((i) => i.effect === "create"),
      dashed: list.length > 0 && list.every((i) => i.trigger === "complete"),
    });
  }
  for (const id of ids) {
    for (const w of arr(nodes[id].checks)) {
      relations.push({ from: w, to: id, kind: "checks", label: "checks", ordering: true });
    }
  }
  for (const id of ids) {
    for (const x of arr(nodes[id].after)) {
      relations.push({ from: x, to: id, kind: "after", label: "after PASS", ordering: true });
    }
  }
  for (const v of needsWork) {
    for (const w of ownWorktree) {
      relations.push({ from: w, to: v, kind: "accepted-work", label: "accepted work", ordering: true });
    }
  }
  for (const id of ids) {
    if (nodes[id].required !== true) continue;
    for (const v of needsWork) {
      relations.push({ from: id, to: v, kind: "required", label: "required PASS", ordering: true });
    }
  }
  return { relations, ownWorktree, needsWork };
}

// Ordering steps: { from, to, cause }. The ordering relations first, then the
// extra rule: a node that requires accepted work follows every other node that
// checks an own-worktree node.
function orderingSteps(graph, relations, ownWorktree, needsWork) {
  const nodes = graph.nodes || {};
  const steps = relations.filter((r) => r.ordering).map((r) => ({ from: r.from, to: r.to, cause: causeOf(r) }));
  for (const v of needsWork) {
    for (const [id, node] of Object.entries(nodes)) {
      if (id === v || !arr(node.checks).some((t) => ownWorktree.includes(t))) continue;
      steps.push({ from: id, to: v, cause: `${v}: requires accepted-work, after ${id}` });
    }
  }
  return steps;
}

function causeOf(r) {
  if (r.kind === "interaction") return `${r.from} -> ${r.to}: ${r.label}`;
  if (r.kind === "checks") return `${r.to}: checks [${r.from}]`;
  if (r.kind === "after") return `${r.to}: after [${r.from}]`;
  if (r.kind === "accepted-work") return `${r.to}: requires accepted-work`;
  return `${r.from}: required`;
}

// The first loop of a depth-first search in the order of the nodes mapping.
function findCycle(ids, steps) {
  const out = new Map(ids.map((id) => [id, []]));
  for (const s of steps) if (out.has(s.from) && out.has(s.to)) out.get(s.from).push(s);
  const state = new Map();
  const path = [];
  const pathSteps = [];
  let found = null;
  const visit = (id) => {
    state.set(id, 1);
    path.push(id);
    for (const s of out.get(id)) {
      if (found) return;
      if (state.get(s.to) === 1) {
        const at = path.indexOf(s.to);
        found = { cycle: [...path.slice(at), s.to], causes: [...pathSteps.slice(at), s.cause] };
        return;
      }
      if (state.get(s.to) === undefined) {
        pathSteps.push(s.cause);
        visit(s.to);
        if (found) return;
        pathSteps.pop();
      }
    }
    path.pop();
    state.set(id, 2);
  };
  for (const id of ids) {
    if (!state.has(id)) visit(id);
    if (found) break;
  }
  return found;
}

// Longest-path columns. The start node is column 0. When a loop blocks the
// order, the first unplaced node (one with a placed predecessor if possible)
// goes one column after its last placed predecessor, so the function ends.
function placeColumns(ids, start, steps) {
  const preds = new Map(ids.map((id) => [id, []]));
  for (const s of steps) if (preds.has(s.to) && preds.has(s.from) && s.to !== start) preds.get(s.to).push(s.from);
  const columns = {};
  if (preds.has(start)) columns[start] = 0;
  const colAfter = (id) => {
    const placed = preds.get(id).filter((p) => has(columns, p));
    return placed.length ? Math.max(...placed.map((p) => columns[p])) + 1 : 0;
  };
  let rest = ids.filter((id) => !has(columns, id));
  while (rest.length) {
    const ready = rest.find((id) => preds.get(id).every((p) => has(columns, p)));
    const blocked = rest.find((id) => preds.get(id).some((p) => has(columns, p))) || rest[0];
    const next = ready !== undefined ? ready : blocked;
    columns[next] = colAfter(next);
    rest = rest.filter((id) => id !== next);
  }
  return columns;
}

// Rows: the start node, then edge targets in the order of first appearance, then the other nodes.
function placeRows(ids, start, edges, columns) {
  const order = ids.includes(start) ? [start] : [];
  for (const e of edges) if (ids.includes(e.to) && !order.includes(e.to)) order.push(e.to);
  for (const id of ids) if (!order.includes(id)) order.push(id);
  const count = {};
  const rows = {};
  for (const id of order) {
    const col = columns[id];
    rows[id] = count[col] || 0;
    count[col] = rows[id] + 1;
  }
  return rows;
}

// graph: { start, nodes, edges, interactions, types }.
// Returns { relations, columns, rows, cycle, cycleCauses }.
function graphRelations(graph) {
  const g = graph || {};
  const ids = Object.keys(g.nodes || {});
  const { relations, ownWorktree, needsWork } = declaredRelations(g);
  const steps = orderingSteps(g, relations, ownWorktree, needsWork);
  const loop = findCycle(ids, steps);
  const columns = placeColumns(ids, g.start, steps);
  const rows = placeRows(ids, g.start, arr(g.edges), columns);
  return { relations, columns, rows, cycle: loop ? loop.cycle : null, cycleCauses: loop ? loop.causes : null };
}

module.exports = { graphRelations };
