"use strict";

// The valid interactions for an arrow from one node to another, for the visual
// editor. Pure: no file reads. An interaction is valid for a pair when adding
// it to the edge gives no new rule error. R2 and R4 are ignored: they fail on
// a pipeline that is not complete yet, and more arrows fix them.
//   edgeOptions({ pipeline, types, interactions, from, to }) -> { error } | { current, options, excluded }
//   catalogInputs(catalog) -> { types, interactions }  (every item of the catalog)

const { checkPipeline } = require("./pipeline-rules");
const { loadAll, resolveOne } = require("./pipeline-model");
const { loadNodeType } = require("./node-types");
const { loadInteraction } = require("./interactions");

const IGNORED_RULES = ["R2", "R4"];

function has(obj, key) {
  return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

const errorKey = (e) => `${e.rule}\0${e.message}`;
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// The resolved node types and the loaded interactions of a catalog.
// A broken item is left out; the catalog reports it as a problem.
function catalogInputs(catalog) {
  const loaded = loadAll(catalog, "types", "NODE.md", (r) => loadNodeType(r.dir, r.readFile));
  const types = {};
  for (const name of Object.keys(loaded)) {
    const type = resolveOne(loaded, name);
    if (type) types[name] = type;
  }
  const interactions = loadAll(catalog, "interactions", "INTERACTION.md", (r, entry) =>
    loadInteraction(r.dir, r.readFile, { builtIn: entry.builtIn === true || entry.layer === "built-in" }));
  return { types, interactions };
}

function edgeOptions({ pipeline, types, interactions, from, to }) {
  const nodes = (pipeline && pipeline.nodes) || {};
  if (typeof from !== "string" || !has(nodes, from)) return { error: `'${from}' is not a node of the pipeline` };
  if (typeof to !== "string" || !has(nodes, to)) return { error: `'${to}' is not a node of the pipeline` };
  if (from === to) return { error: "an edge needs two different nodes" };

  const samePair = (e) => e.from === from && e.to === to;
  const current = [];
  for (const edge of pipeline.edges || []) {
    if (samePair(edge)) for (const name of edge.interactions || []) if (!current.includes(name)) current.push(name);
  }

  const baseline = new Set(checkPipeline(pipeline, types, interactions).map(errorKey));
  const options = [];
  const excluded = [];
  for (const name of Object.keys(interactions).sort()) {
    if (current.includes(name)) continue;
    const copy = JSON.parse(JSON.stringify(pipeline));
    const edges = (copy.edges || []).filter((e) => !samePair(e));
    // One edge for the pair, at the place of the first old one.
    const index = (copy.edges || []).findIndex(samePair);
    const edge = { from, to, interactions: [...current, name] };
    if (index < 0) edges.push(edge);
    else edges.splice(index, 0, edge);
    copy.edges = edges;
    const fresh = checkPipeline(copy, types, interactions)
      .filter((e) => !IGNORED_RULES.includes(e.rule) && !baseline.has(errorKey(e)));
    if (fresh.length === 0) {
      const { description, effect, trigger, target } = interactions[name];
      options.push({ name, description, effect, trigger, target });
    } else {
      excluded.push({ name, reasons: fresh.map((e) => e.message) });
    }
  }
  return { current, options: options.sort(byName), excluded: excluded.sort(byName) };
}

module.exports = { edgeOptions, catalogInputs };
