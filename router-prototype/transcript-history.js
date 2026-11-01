"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const readline = require("node:readline");

const LIMIT = 500;
const list = async (dir) => {
  try { return await fs.promises.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
};
const exists = async (file) => {
  try { await fs.promises.access(file); return true; } catch { return false; }
};

async function findSession({ harness, sessionId, workdir }, env = process.env) {
  if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
  if (harness === "pi") {
    const root = path.join(env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "sessions");
    const dirs = [path.join(workdir, "sessions"),
      path.join(root, `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`)];
    for (const e of await list(root)) if (e.isDirectory()) dirs.push(path.join(root, e.name));
    for (const dir of new Set(dirs)) {
      const file = (await list(dir)).find(e => e.isFile() && e.name.endsWith(`_${sessionId}.jsonl`));
      if (file) return path.join(dir, file.name);
    }
  } else if (harness === "claude") {
    const root = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
    const dirs = [path.join(root, workdir.replace(/[^a-zA-Z0-9]/g, "-"))];
    for (const e of await list(root)) if (e.isDirectory()) dirs.push(path.join(root, e.name));
    for (const dir of new Set(dirs)) {
      const file = path.join(dir, `${sessionId}.jsonl`);
      if (await exists(file)) return file;
    }
  } else if (harness === "codex") {
    const root = path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
    const walk = async (dir, depth) => {
      for (const e of await list(dir)) {
        if (e.isFile() && e.name.endsWith(`-${sessionId}.jsonl`)) return path.join(dir, e.name);
        if (e.isDirectory() && depth < 3) {
          const file = await walk(path.join(dir, e.name), depth + 1);
          if (file) return file;
        }
      }
      return null;
    };
    return walk(root, 0);
  }
  return null;
}

function contentText(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter(p => p && ["text", "input_text", "output_text"].includes(p.type))
    .map(p => typeof p.text === "string" ? p.text : "").join("") : "";
}

function historyEntry(record, sessionId) {
  const message = record.message || (record.type === "response_item" ? record.payload : null);
  // System prompts, reasoning blocks, tool results and attachments are not chat.
  if (!message || !["user", "assistant"].includes(message.role)) return null;
  const text = contentText(message.content);
  if (!text) return null;
  const timestamp = message.timestamp || record.timestamp;
  const at = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  return { type: "message", role: message.role, text, sessionId,
    at: Number.isFinite(at) ? at : 0,
    entryId: `session:${sessionId}:${record.id || record.uuid || record.timestamp}` };
}

async function readSession(file, harness, sessionId) {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const nodes = new Map();
  const linear = [];
  let leaf = null;
  try {
    for await (const line of input) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type === "session" && record.id !== sessionId) return [];
      if (record.sessionId && record.sessionId !== sessionId) continue;
      const entry = historyEntry(record, sessionId);
      if (harness === "pi" && record.id && record.type !== "session") {
        nodes.set(record.id, { parent: record.parentId, entry });
        leaf = record.id;
      } else if (entry) {
        linear.push(entry);
      }
    }
  } finally { input.close(); stream.destroy(); }
  if (harness !== "pi") return linear;
  const branch = [], seen = new Set();
  while (leaf && nodes.has(leaf) && !seen.has(leaf)) {
    seen.add(leaf);
    const node = nodes.get(leaf);
    if (node.entry) branch.push(node.entry);
    leaf = node.parent;
  }
  return branch.reverse();
}

// Router entries have stream-time timestamps, session records have provider-time
// timestamps. Collapse only matching messages close in time, not repeated turns.
function sameMessage(a, b) {
  return (a.entryId && a.entryId === b.entryId) ||
    (a.role === b.role && a.text === b.text && a.sessionId === b.sessionId
      && Math.abs((a.at || 0) - (b.at || 0)) < 10_000);
}

async function loadTranscript(target, options = {}) {
  const file = await findSession(target, options.env);
  const saved = file ? await readSession(file, target.harness, target.sessionId) : [];
  const live = target.transcript || [];
  const entries = saved.filter(entry => !live.some(other => sameMessage(entry, other))).concat(live);
  entries.sort((a, b) => (a.at || 0) - (b.at || 0));
  return { entries: entries.slice(-LIMIT), truncated: entries.length > LIMIT,
    available: !!file || live.length > 0 };
}

module.exports = { findSession, readSession, loadTranscript, sameMessage, historyEntry };
