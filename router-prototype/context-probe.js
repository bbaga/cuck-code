"use strict";

// Context size from a harness's own session files, for harnesses that do
// not report token usage on their stdout stream:
// - vibe writes ~/.vibe/logs/session/session_<time>_<id prefix>/meta.json
//   with stats.context_tokens (the context after the latest turn).
// - codex writes ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl
//   with token_count events; the last one's last_token_usage is the latest
//   model call (input includes cached input).
// claude and pi report usage on their streams (see harness.js). Every
// reader returns null when it finds nothing; callers then fall back to the
// character estimate.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CODEX_TAIL_BYTES = 512 * 1024;

function positive(n) {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function vibeContextTokens(sessionId, env = process.env) {
  if (typeof sessionId !== "string" || sessionId.length < 8) return null;
  const home = env.VIBE_HOME || path.join(os.homedir(), ".vibe");
  const dir = path.join(home, "logs", "session");
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const suffix = "_" + sessionId.slice(0, 8);
  for (const name of names.filter((n) => n.endsWith(suffix)).sort().reverse()) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, name, "meta.json"), "utf8"));
      if (meta.session_id !== sessionId) continue;
      const tokens = positive(meta.stats && meta.stats.context_tokens);
      return tokens || null;
    } catch {}
  }
  return null;
}

const codexPaths = new Map();

function findCodexRollout(root, sessionId) {
  const cached = codexPaths.get(sessionId);
  if (cached && fs.existsSync(cached)) return cached;
  const suffix = `-${sessionId}.jsonl`;
  // Newest first: date directories sort lexically.
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith(suffix)) return p;
      if (e.isDirectory() && depth < 3) {
        const found = walk(p, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  const found = walk(root, 0);
  if (found) codexPaths.set(sessionId, found);
  return found;
}

function codexContextTokens(sessionId, env = process.env) {
  if (typeof sessionId !== "string" || !sessionId) return null;
  const home = env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const file = findCodexRollout(path.join(home, "sessions"), sessionId);
  if (!file) return null;
  let text;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, CODEX_TAIL_BYTES);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      text = buf.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  const records = text.split("\n");
  for (let i = records.length - 1; i >= 0; i--) {
    if (!records[i].includes('"token_count"')) continue;
    let rec;
    try { rec = JSON.parse(records[i]); } catch { continue; }
    const payload = rec.payload || rec;
    const last = payload.info && payload.info.last_token_usage;
    if (!last) continue;
    const tokens = positive(last.input_tokens) + positive(last.output_tokens);
    if (tokens) return tokens;
  }
  return null;
}

const READERS = { vibe: vibeContextTokens, codex: codexContextTokens };

// Latest context size of a session from the harness's own files, or null.
function sessionContextTokens(harnessId, sessionId, env) {
  const reader = READERS[harnessId];
  if (!reader) return null;
  try { return reader(sessionId, env); } catch { return null; }
}

module.exports = { sessionContextTokens, vibeContextTokens, codexContextTokens };
