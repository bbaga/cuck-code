"use strict";

// Context size from a harness's completed session files:
// - vibe writes ~/.vibe/logs/session/session_<time>_<id prefix>/meta.json
//   with stats.context_tokens (the context after the latest turn).
// - codex writes ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl
//   with token_count events; the last one's last_token_usage is the latest
//   model call (input includes cached input).
// - claude writes completed per-call usage to its project session JSONL;
//   streamed assistant events can precede the final provider usage.
// pi reports usage on its stream (see harness.js). Readers return null when
// they find nothing; callers retain stream usage or the character estimate.

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

const CLAUDE_TAIL_BYTES = 4 * 1024 * 1024;

function claudeContextTokens(sessionId, env = process.env, workdir) {
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(sessionId)
    || typeof workdir !== "string" || !path.isAbsolute(workdir)) return null;
  const home = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const project = workdir.replace(/[^a-zA-Z0-9]/g, "-");
  const file = path.join(home, "projects", project, `${sessionId}.jsonl`);
  let text;
  let start;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, CLAUDE_TAIL_BYTES);
      start = size - length;
      const buf = Buffer.alloc(length);
      const bytes = fs.readSync(fd, buf, 0, length, start);
      text = buf.toString("utf8", 0, bytes);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  const records = text.split("\n");
  // The first record can start outside the bounded tail.
  const first = start > 0 ? 1 : 0;
  for (let i = records.length - 1; i >= first; i--) {
    if (!records[i].includes('"usage"')) continue;
    let rec;
    try { rec = JSON.parse(records[i]); } catch { continue; }
    if (!rec || rec.type !== "assistant" || rec.isSidechain || rec.is_api_error_message
      || rec.error || (rec.sessionId && rec.sessionId !== sessionId)
      || rec.message?.role !== "assistant") continue;
    const usage = rec.message.usage;
    if (!usage) continue;
    const tokens = positive(usage.input_tokens) + positive(usage.cache_creation_input_tokens)
      + positive(usage.cache_read_input_tokens) + positive(usage.output_tokens);
    if (tokens) return tokens;
  }
  return null;
}

const READERS = { vibe: vibeContextTokens, codex: codexContextTokens, claude: claudeContextTokens };

// Latest context size of a session from the harness's own files, or null.
function sessionContextTokens(harnessId, sessionId, env, workdir) {
  const reader = READERS[harnessId];
  if (!reader) return null;
  try { return reader(sessionId, env, workdir); } catch { return null; }
}

function contextTokensForRun(adapter, sessionId, env, workdir) {
  if (adapter.id === "claude") {
    return sessionContextTokens(adapter.id, sessionId, env, workdir) || adapter.contextTokens;
  }
  return adapter.contextTokens || sessionContextTokens(adapter.id, sessionId, env, workdir);
}

module.exports = { sessionContextTokens, contextTokensForRun,
  vibeContextTokens, codexContextTokens, claudeContextTokens };
