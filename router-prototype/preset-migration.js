"use strict";

// One-time migration of the old pipeline presets (<LINES_DIR>/pipeline-presets.json)
// to pipeline files in the managed layer. Runs at boot, before the catalog is built.
// Each preset becomes the built-in default pipeline with the preset settings placed
// on the nodes whose type maps to each phase. All file access goes through `fs`.

const path = require("node:path");
const YAML = require("yaml");
const { phaseOfType } = require("./line-graph");
const { setNodeSettingsInDoc } = require("./pipelines-api");
const { PHASES, CONTEXT_PHASES, validateNodeSettings } = require("./pipeline-config");

const MAX_FILE_NAME = 60;
const MAX_NAME_LENGTH = 60;

// Check an old per-phase pipeline object (the shape of a stored preset).
// Returns an error string or null.
function validatePipelineConfig(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "pipeline must be an object";
  for (const key of Object.keys(raw)) {
    if (!PHASES.includes(key)) return `unknown pipeline phase: '${key}' (allowed: ${PHASES.join(", ")})`;
    const phase = raw[key];
    if (phase === null || typeof phase !== "object" || Array.isArray(phase)) {
      return `pipeline.${key} must be an object`;
    }
    const message = validateNodeSettings(`pipeline.${key}`, phase, {
      strict: true,
      maxContext: CONTEXT_PHASES.includes(key),
    });
    if (message) return message;
  }
  return null;
}

// Check one stored preset. A preset must configure at least one phase.
function presetError(name, pipeline) {
  if (typeof name !== "string" || !name.trim()) return "preset name must be a non-empty string";
  if (name.trim().length > MAX_NAME_LENGTH) return `preset name must be at most ${MAX_NAME_LENGTH} characters`;
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

// A safe file name: lowercase [a-z0-9-], at most 60 characters, never empty.
function safeFileName(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-")
    .replace(/^-+/, "").slice(0, MAX_FILE_NAME).replace(/-+$/, "");
  return base || "preset";
}

// First free name: base, base-2, base-3 ... (the suffix fits inside 60 characters).
function uniqueName(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, MAX_FILE_NAME - suffix.length).replace(/-+$/, "") + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

// The default pipeline text with a new name, description and node settings.
function presetPipelineText(defaultPipelineText, defaultGraph, fileName, oldName, settingsByPhase) {
  const doc = YAML.parseDocument(defaultPipelineText);
  doc.setIn(["name"], fileName);
  doc.setIn(["description"], `Migrated from preset '${oldName}'`);
  for (const [id, node] of Object.entries(defaultGraph.nodes)) {
    const phase = phaseOfType(defaultGraph, node.type);
    const settings = phase && settingsByPhase[phase];
    if (!settings || typeof settings !== "object") continue;
    setNodeSettingsInDoc(doc, id, settings);
  }
  return doc.toString();
}

// Returns { migrated: [{ from, to }], error? }. Never throws.
function migratePresets({ presetsFile, managedDir, defaultPipelineText, defaultGraph, fs, log = () => {},
  reservedNames = [] }) {
  if (!fs.existsSync(presetsFile)) return { migrated: [] };
  const written = [];
  const temps = [];
  try {
    const presets = restorePresets(JSON.parse(fs.readFileSync(presetsFile, "utf8")));
    const dir = path.join(managedDir, "pipelines");
    fs.mkdirSync(dir, { recursive: true });
    const taken = new Set(reservedNames);
    for (const e of fs.readdirSync(dir)) {
      const m = /^(.+)\.yaml$/.exec(typeof e === "string" ? e : e.name);
      if (m) taken.add(m[1]);
    }
    const plan = [];
    for (const preset of presets) {
      const file = uniqueName(safeFileName(preset.name), taken);
      taken.add(file);
      plan.push({ from: preset.name, to: file,
        text: presetPipelineText(defaultPipelineText, defaultGraph, file, preset.name, preset.pipeline) });
    }
    for (const item of plan) {
      const final = path.join(dir, `${item.to}.yaml`);
      const temp = `${final}.tmp-${process.pid}`;
      temps.push(temp);
      fs.writeFileSync(temp, item.text);
      fs.renameSync(temp, final);
      written.push(final);
    }
    fs.renameSync(presetsFile, `${presetsFile}.migrated`);
    for (const item of plan) log(`preset migrated: '${item.from}' -> '${item.to}'`);
    return { migrated: plan.map((i) => ({ from: i.from, to: i.to })) };
  } catch (err) {
    for (const f of [...written, ...temps]) {
      try { fs.rmSync(f, { force: true }); } catch {}
    }
    try { log(`preset migration failed (the old file is kept): ${err.message}`); } catch {}
    return { migrated: [], error: err.message };
  }
}

module.exports = { migratePresets, safeFileName, validatePipelineConfig, presetError, restorePresets };
