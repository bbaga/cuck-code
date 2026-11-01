"use strict";

// The plugin catalog: read the three layers (managed, user, built-in) and build
// the catalog that resolvePipelineDefinition expects. All file access goes
// through the injected readDir / readFile.
//
// buildCatalog returns { readFile, types, interactions, pipelines, problems, shadowed }:
//   types / interactions / pipelines: { name: { folder | file, layer, builtIn? } }
//   problems: [{ layer, path, errors: [string] }]
//   shadowed: [{ kind, name, layer, shadowedBy }]   (the lower layer lost)

const fs = require("node:fs");
const path = require("node:path");
const { loadNodeType } = require("./node-types");
const { loadInteraction } = require("./interactions");
const { parsePipeline } = require("./pipelines");

function defaultReadDir(dir) {
  return fs.readdirSync(dir, { withFileTypes: true });
}
function defaultReadFile(file) {
  return fs.readFileSync(file, "utf8");
}

const KINDS = [
  { kind: "node-type", map: "types", dir: "node-types", folders: true, file: "NODE.md" },
  { kind: "interaction", map: "interactions", dir: "interactions", folders: true, file: "INTERACTION.md" },
  { kind: "pipeline", map: "pipelines", dir: "pipelines", folders: false },
];

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function buildCatalog({ managedDir, userDir, builtInDir, readDir = defaultReadDir, readFile = defaultReadFile } = {}) {
  const layers = [
    { layer: "managed", root: managedDir },
    { layer: "user", root: userDir },
    { layer: "built-in", root: builtInDir },
  ].filter((l) => typeof l.root === "string" && l.root !== "");

  const catalog = { readFile, types: {}, interactions: {}, pipelines: {}, problems: [], shadowed: [] };
  const problem = (layer, p, errors) => catalog.problems.push({ layer, path: p, errors });

  // The entries found in one layer: [{ name, path, folder|file }], sorted by name.
  function list(layer, root, spec) {
    const dir = path.join(root, spec.dir);
    let items;
    try {
      items = readDir(dir);
    } catch (err) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return [];
      problem(layer, dir, [`cannot read folder: ${err.message}`]);
      return [];
    }
    const out = [];
    for (const e of items) {
      if (spec.folders) {
        if (e.isDirectory()) out.push({ name: e.name, path: path.join(dir, e.name, spec.file), folder: path.join(dir, e.name) });
      } else {
        const m = /^(.+)\.yaml$/.exec(e.name);
        if (m && e.isFile()) out.push({ name: m[1], path: path.join(dir, e.name), file: path.join(dir, e.name) });
      }
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // Does the entry load? Returns an error message, or null.
  function check(spec, layer, entry) {
    try {
      if (spec.kind === "node-type") loadNodeType(entry.folder, readFile);
      else if (spec.kind === "interaction") loadInteraction(entry.folder, readFile, { builtIn: layer === "built-in" });
      else parsePipeline(readFile(entry.file), entry.file, readFile);
      return null;
    } catch (err) {
      return err.message;
    }
  }

  for (const spec of KINDS) {
    const found = layers.map((l) => ({ ...l, entries: list(l.layer, l.root, spec) }));
    const builtInNames = new Set();
    for (const l of found) if (l.layer === "built-in") for (const e of l.entries) builtInNames.add(e.name);

    const map = catalog[spec.map];
    for (const l of found) { // highest priority first
      for (const e of l.entries) {
        if (l.layer !== "built-in" && builtInNames.has(e.name)) {
          problem(l.layer, e.path, [`${spec.kind} '${e.name}' uses a built-in name; the built-in one is kept (use extends to build on it)`]);
          continue;
        }
        const message = check(spec, l.layer, e);
        if (message !== null) {
          problem(l.layer, e.path, [message]);
          continue;
        }
        if (has(map, e.name)) {
          catalog.shadowed.push({ kind: spec.kind, name: e.name, layer: l.layer, shadowedBy: map[e.name].layer });
          continue;
        }
        const entry = e.folder ? { folder: e.folder, layer: l.layer } : { file: e.file, layer: l.layer };
        if (spec.kind === "interaction" && l.layer === "built-in") entry.builtIn = true;
        map[e.name] = entry;
      }
    }
  }
  return catalog;
}

module.exports = { buildCatalog, defaultReadDir, defaultReadFile };
