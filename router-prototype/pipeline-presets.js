"use strict";

// Pipeline presets: named pipeline configurations the create form can save
// and reuse. Stored as one JSON file next to the lines. Pure helpers plus a
// small file-backed store; server.js wires them to the HTTP routes.

const fs = require("node:fs");
const { validatePipelineConfig } = require("./pipeline-config");

const MAX_NAME_LENGTH = 60;
const MAX_PRESETS = 100;

function presetNameError(name) {
  if (typeof name !== "string" || !name.trim()) return "preset name must be a non-empty string";
  if (name.trim().length > MAX_NAME_LENGTH) return `preset name must be at most ${MAX_NAME_LENGTH} characters`;
  return null;
}

// Validate a preset body. A preset must configure at least one phase: an
// empty preset is the same as the defaults and is not worth a name.
function presetError(name, pipeline) {
  const nameError = presetNameError(name);
  if (nameError) return nameError;
  if (!pipeline || typeof pipeline !== "object" || !Object.keys(pipeline).length) {
    return "preset pipeline must configure at least one phase";
  }
  return validatePipelineConfig(pipeline);
}

// Keep only entries that are still valid: a preset written by an older
// router can carry fields this one rejects.
function restorePresets(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (!p || presetError(p.name, p.pipeline)) continue;
    const name = p.name.trim();
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, pipeline: p.pipeline, updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function createPresetStore(file, { writeFile } = {}) {
  const write = writeFile || ((f, text) => fs.writeFileSync(f, text));
  let presets = null;
  const load = () => {
    if (presets) return presets;
    try { presets = restorePresets(JSON.parse(fs.readFileSync(file, "utf8"))); }
    catch { presets = []; }
    return presets;
  };
  const save = () => write(file, JSON.stringify(presets, null, 2));
  return {
    list: () => load().map((p) => ({ ...p })),
    // Create or replace by name. Returns { error } or { preset, created }.
    put(name, pipeline, now = new Date()) {
      const error = presetError(name, pipeline);
      if (error) return { error };
      const list = load();
      const key = name.trim();
      const existing = list.findIndex((p) => p.name === key);
      if (existing === -1 && list.length >= MAX_PRESETS) return { error: `at most ${MAX_PRESETS} presets` };
      const preset = { name: key, pipeline, updatedAt: now.toISOString() };
      if (existing === -1) list.push(preset); else list[existing] = preset;
      list.sort((a, b) => a.name.localeCompare(b.name));
      save();
      return { preset, created: existing === -1 };
    },
    remove(name) {
      const list = load();
      const index = list.findIndex((p) => p.name === String(name).trim());
      if (index === -1) return false;
      list.splice(index, 1);
      save();
      return true;
    },
  };
}

module.exports = { presetError, restorePresets, createPresetStore, MAX_NAME_LENGTH };
