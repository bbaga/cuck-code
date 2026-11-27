"use strict";

// The pipeline model: a JSON view of a pipeline text for the visual editor.
//   textToModel(text)            -> { errors, model }
//   modelToText(model, baseText) -> text (keeps comments and layout of what did not change)
//   paletteFromCatalog(catalog)  -> { nodeTypes, interactions, nodeKeys }
// The browser has no YAML library, so the server does this work.

const { isDeepStrictEqual } = require("node:util");
const YAML = require("yaml");
const { NODE_KEYS, SETTING_KEYS, ID_RE, CHECKOUTS, MAX_ROUNDS_LIMIT, SCRIPT_KEYS } = require("./pipelines");
const { loadNodeType, resolveTypes } = require("./node-types");
const { loadInteraction } = require("./interactions");

const KNOWN_TOP_KEYS = ["name", "description", "start", "defaults", "nodes", "edges"];
const BASE_TYPES = ["implementor", "validator"];

const isMapping = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ---- edge items ----

function parseSide(text) {
  const t = text.trim();
  const parts = t.startsWith("[") && t.endsWith("]") ? t.slice(1, -1).split(",") : [t];
  const ids = parts.map((p) => p.trim());
  const bad = ids.find((id) => !ID_RE.test(id));
  if (bad !== undefined) throw new Error(`'${bad}' is not a node id`);
  return ids;
}

// One YAML edge item (a string, or a mapping with one key) -> [{ from, to, interactions }].
function parseEdgeItem(item) {
  let text = item;
  if (isMapping(item) && Object.keys(item).length === 1) {
    const [key] = Object.keys(item);
    text = `${key}: ${item[key] === null ? "" : item[key]}`;
  }
  if (typeof text !== "string") throw new Error("an edge must be a string '<from> -> <to>: <interaction>[, ...]'");
  const arrow = text.indexOf("->");
  if (arrow < 0) throw new Error("missing '->'");
  const colon = text.indexOf(":", arrow + 2);
  if (colon < 0) throw new Error("missing ':' and the interaction names");
  const from = parseSide(text.slice(0, arrow));
  const to = parseSide(text.slice(arrow + 2, colon));
  const names = text.slice(colon + 1).split(",").map((s) => s.trim());
  const badName = names.find((n) => !ID_RE.test(n));
  if (badName !== undefined) throw new Error(`'${badName}' is not an interaction name`);
  return from.flatMap((f) => to.map((t) => ({ from: f, to: t, interactions: names.slice() })));
}

// ---- text -> model ----

function textToModel(text) {
  const loadError = (message) => ({ errors: [{ rule: "LOAD", message }], model: null });
  const doc = YAML.parseDocument(String(text));
  if (doc.errors.length) return loadError(doc.errors.map((e) => e.message).join("; "));
  const raw = doc.toJS();
  if (!isMapping(raw)) return loadError("the file must be a YAML mapping");

  const nodes = [];
  if (raw.nodes !== undefined) {
    if (!isMapping(raw.nodes)) return loadError("nodes must be a mapping");
    for (const [id, node] of Object.entries(raw.nodes)) {
      if (!isMapping(node)) return loadError(`node '${id}' must be a mapping`);
      nodes.push({ id, ...node });
    }
  }

  const edges = [];
  if (raw.edges !== undefined) {
    if (!Array.isArray(raw.edges)) return loadError("edges must be a list");
    for (const [item, value] of raw.edges.entries()) {
      try {
        for (const pair of parseEdgeItem(value)) edges.push({ ...pair, item });
      } catch (err) {
        return loadError(`edge ${item}: ${err.message}`);
      }
    }
  }

  const extra = {};
  for (const key of Object.keys(raw)) if (!KNOWN_TOP_KEYS.includes(key)) extra[key] = raw[key];
  const model = {
    name: raw.name,
    description: raw.description === undefined ? null : raw.description,
    start: raw.start,
    defaults: isMapping(raw.defaults) ? raw.defaults : {},
    nodes,
    edges,
    extra,
  };
  return { errors: [], model };
}

// ---- model -> text ----

// The message for a model that has not the documented shape, or null.
function modelError(model) {
  if (!isMapping(model)) return "model must be an object";
  if (typeof model.name !== "string") return "model.name must be a string";
  if (typeof model.start !== "string") return "model.start must be a string";
  if (model.description !== undefined && model.description !== null && typeof model.description !== "string") {
    return "model.description must be a string or null";
  }
  for (const key of ["defaults", "extra"]) {
    if (model[key] !== undefined && !isMapping(model[key])) return `model.${key} must be an object`;
  }
  if (!Array.isArray(model.nodes)) return "model.nodes must be a list";
  const ids = new Set();
  for (const [i, node] of model.nodes.entries()) {
    if (!isMapping(node) || typeof node.id !== "string" || node.id === "") return `model.nodes[${i}] needs a string id`;
    if (ids.has(node.id)) return `model.nodes[${i}]: the id '${node.id}' is used twice`;
    ids.add(node.id);
  }
  if (!Array.isArray(model.edges)) return "model.edges must be a list";
  for (const [i, e] of model.edges.entries()) {
    if (!isMapping(e) || typeof e.from !== "string" || typeof e.to !== "string") {
      return `model.edges[${i}] needs string from and to`;
    }
    if (!Array.isArray(e.interactions) || e.interactions.length === 0 || e.interactions.some((n) => typeof n !== "string")) {
      return `model.edges[${i}].interactions must be a non-empty list of strings`;
    }
    if (e.item !== undefined && e.item !== null && !Number.isInteger(e.item)) return `model.edges[${i}].item must be an integer`;
  }
  return null;
}

// Set path to value unless the text already has an equal value.
function setIfChanged(doc, raw, path, value) {
  const current = path.reduce((v, k) => (isMapping(v) ? v[k] : undefined), raw);
  if (!isDeepStrictEqual(current, value)) doc.setIn(path, value);
}

function dropMissing(doc, raw, path, wanted) {
  const current = path.reduce((v, k) => (isMapping(v) ? v[k] : undefined), raw);
  if (!isMapping(current)) return;
  for (const key of Object.keys(current)) if (!wanted.includes(key)) doc.deleteIn([...path, key]);
}

function applyTop(doc, raw, model) {
  const top = { name: model.name, start: model.start };
  if (typeof model.description === "string") top.description = model.description;
  if (isMapping(model.defaults) && Object.keys(model.defaults).length) top.defaults = model.defaults;
  Object.assign(top, model.extra || {});
  for (const [key, value] of Object.entries(top)) setIfChanged(doc, raw, [key], value);
  for (const key of Object.keys(raw)) {
    if (key !== "nodes" && key !== "edges" && !(key in top)) doc.deleteIn([key]);
  }
}

function applyNodes(doc, raw, model) {
  const rawNodes = isMapping(raw.nodes) ? raw.nodes : {};
  const wantedIds = model.nodes.map((n) => n.id);
  for (const id of Object.keys(rawNodes)) if (!wantedIds.includes(id)) doc.deleteIn(["nodes", id]);
  for (const { id, ...keys } of model.nodes) {
    if (!(id in rawNodes) || !isMapping(rawNodes[id])) {
      doc.setIn(["nodes", id], keys);
      continue;
    }
    for (const [key, value] of Object.entries(keys)) setIfChanged(doc, raw, ["nodes", id, key], value);
    dropMissing(doc, raw, ["nodes", id], Object.keys(keys));
  }
  // New and renamed nodes were added at the end: move them to their place.
  const map = doc.get("nodes", true);
  if (YAML.isMap(map)) {
    const order = (pair) => wantedIds.indexOf(String(pair.key && pair.key.value !== undefined ? pair.key.value : pair.key));
    const sorted = map.items.slice().sort((a, b) => order(a) - order(b));
    if (sorted.some((p, i) => p !== map.items[i])) map.items = sorted;
  }
}

const pairKey = (e) => `${e.from}\0${e.to}`;
const sameInteractions = (a, b) => isDeepStrictEqual(a, b);
const pairText = (e) => `${e.from} -> ${e.to}: ${e.interactions.join(", ")}`;

function applyEdges(doc, raw, model) {
  const byItem = new Map();
  const added = [];
  for (const e of model.edges) {
    if (Number.isInteger(e.item)) {
      if (!byItem.has(e.item)) byItem.set(e.item, []);
      byItem.get(e.item).push(e);
    } else added.push(e);
  }
  const seq = doc.get("edges", true);
  const rawItems = Array.isArray(raw.edges) ? raw.edges : [];
  const next = [];
  let changed = added.length > 0;
  rawItems.forEach((value, i) => {
    const original = parseEdgeItem(value);
    const now = byItem.get(i) || [];
    const same = original.length === now.length && original.every((p) => {
      const m = now.find((e) => pairKey(e) === pairKey(p));
      return m && sameInteractions(m.interactions, p.interactions);
    });
    if (same) {
      next.push(seq.items[i]);
      return;
    }
    changed = true;
    for (const e of now) next.push(doc.createNode(pairText(e)));
  });
  for (const e of byItem.keys()) if (e >= rawItems.length) changed = true;
  if (!changed) return;
  for (const [item, list] of byItem) {
    if (item >= rawItems.length) for (const e of list) next.push(doc.createNode(pairText(e)));
  }
  for (const e of added) next.push(doc.createNode(pairText(e)));
  if (YAML.isSeq(seq)) seq.items = next;
  else doc.setIn(["edges"], next.map((n) => n.value));
}

function modelToText(model, baseText) {
  const message = modelError(model);
  if (message) throw new TypeError(message);
  const base = typeof baseText === "string" && baseText.trim() !== "" ? baseText : "";
  const doc = base === "" ? new YAML.Document({}) : YAML.parseDocument(base);
  if (doc.errors.length) throw new TypeError(`baseText is not valid YAML: ${doc.errors[0].message}`);
  const raw = doc.toJS();
  if (raw !== null && !isMapping(raw)) throw new TypeError("baseText must be a YAML mapping");
  const current = raw || {};
  if (!doc.contents || !YAML.isMap(doc.contents)) doc.contents = doc.createNode({});
  const before = JSON.stringify(current);
  applyTop(doc, current, model);
  applyNodes(doc, current, model);
  applyEdges(doc, current, model);
  // Nothing changed: keep the text byte for byte (the writer would reformat it).
  if (base !== "" && JSON.stringify(doc.toJS()) === before) return base;
  return doc.toString({ lineWidth: 0 });
}

// ---- palette ----

function entryReader(catalog, name, entry, fileName) {
  if (typeof entry.text === "string") {
    const dir = entry.folder || name;
    return { dir, readFile: (p) => {
      if (p === fileName(dir)) return entry.text;
      throw new Error(`no such file '${p}'`);
    } };
  }
  if (typeof entry.folder === "string" && typeof catalog.readFile === "function") {
    return { dir: entry.folder, readFile: (p) => catalog.readFile(p) };
  }
  return null;
}
const folderFile = (file) => (d) => `${d.replace(/[\\/]+$/, "")}/${file}`;

function loadAll(catalog, map, file, load) {
  const out = {};
  for (const [name, entry] of Object.entries(catalog[map] || {})) {
    const reader = entryReader(catalog, name, entry, folderFile(file));
    if (!reader) continue;
    try { out[name] = load(reader, entry); } catch { /* a broken item is reported by the catalog problems */ }
  }
  return out;
}

function resolveOne(loaded, name) {
  const subset = {};
  for (let cur = loaded[name]; cur && !(cur.name in subset); cur = loaded[cur.extends]) subset[cur.name] = cur;
  try { return resolveTypes(subset)[name]; } catch { return null; }
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function paletteFromCatalog(catalog) {
  const cat = catalog || {};
  const loaded = loadAll(cat, "types", "NODE.md", (r) => loadNodeType(r.dir, r.readFile));
  const nodeTypes = [];
  for (const name of Object.keys(loaded)) {
    const t = resolveOne(loaded, name);
    if (!t) continue;
    nodeTypes.push({
      name, description: t.description, layer: cat.types[name].layer || null,
      extends: t.extends === undefined ? null : t.extends,
      session: t.session, workspace: t.workspace, outcome: t.outcome, runner: t.runner,
      coordinator: t.coordinator, base: BASE_TYPES.includes(name), fields: t.fields,
    });
  }
  const loadedInteractions = loadAll(cat, "interactions", "INTERACTION.md", (r, entry) =>
    loadInteraction(r.dir, r.readFile, { builtIn: entry.builtIn === true || entry.layer === "built-in" }));
  const interactions = Object.entries(loadedInteractions).map(([name, i]) => ({
    name, description: i.description, layer: cat.interactions[name].layer || null,
    effect: i.effect, trigger: i.trigger, target: i.target, when: i.when === undefined ? null : i.when,
    fallback: i.fallback === undefined ? null : i.fallback, fields: i.fields,
  }));
  return {
    nodeTypes: nodeTypes.sort(byName),
    interactions: interactions.sort(byName),
    nodeKeys: { keys: NODE_KEYS, settingKeys: SETTING_KEYS, checkouts: CHECKOUTS,
      maxRoundsLimit: MAX_ROUNDS_LIMIT, scriptKeys: SCRIPT_KEYS, idPattern: ID_RE.source },
  };
}

module.exports = { textToModel, modelToText, modelError, paletteFromCatalog };
