'use strict';

// Harness adapter layer.
//
// The router starts one child process per harness CLI (vibe, pi, codex,
// claude). It creates one adapter instance per child process with
// createHarness(id), feeds every parsed stdout JSON line to normalize(),
// and calls finalize() when the stream ends. Each instance keeps its own
// state: the captured session id and (for pi) accumulated text deltas.
//
// normalize() returns a common entry:
//   { type: "message", role, text, sessionId, at }
// It preserves explicit source roles and uses null when the source omits a
// role. Only the exact "assistant" role is trusted by report capture.
//
// buildRun() also carries an optional trusted system prompt (ctx.systemPrompt,
// ctx.systemPromptFile) through each harness's verified native channel. See
// SYSTEM_PROMPT_CHANNELS below; harnesses without a verified channel refuse
// the policy instead of falling back to user text.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const HARNESS_IDS = ['vibe', 'pi', 'codex', 'claude'];

// Verified native channels for router-owned system prompt text (the trusted
// planner policy). Each channel lists the CLI flags checked against the
// harness's own documentation: `file` takes a router-owned file path
// (preferred: it keeps the policy body off the command line), `text` takes
// inline text. A `null` entry means the harness has no verified trusted
// system or developer instruction channel: it must never receive the policy,
// and callers must fail closed instead of prefixing it to the user prompt.
//
// - pi: `--append-system-prompt <text|path>` appends text or the contents of
//   an existing file to the system prompt (pi CLI reference, repeatable).
// - claude: `--append-system-prompt-file <path>` loads system prompt text from
//   a file and appends it to the default prompt; `--append-system-prompt`
//   appends inline text (Claude Code CLI reference, both valid headless).
// - vibe and codex document no trusted system prompt flag for headless runs.
// Verified system prompt channels per harness. `file` is the flag that takes
// a router-owned policy file path (null when the harness has no file
// channel); `text` is the flag that takes inline policy text, prefixed by
// `textPrefix` when the flag expects a key=value assignment. All channels
// are verified against the harness's own documentation:
// - pi: `--append-system-prompt <file|text>` appends the policy to the
//   system prompt (same flag for both forms).
// - codex: `-c developer_instructions=<text>` adds developer instructions to
//   the session (Codex config reference). The assignment is one argv element
//   after -c. Codex has no file-based channel, so a file-only request fails
//   closed instead of falling back to the user prompt.
// - claude: `--append-system-prompt-file <file>` and
//   `--append-system-prompt <text>` carry the policy in the system prompt.
const SYSTEM_PROMPT_CHANNELS = {
  vibe: null,
  pi: { file: '--append-system-prompt', text: '--append-system-prompt', textPrefix: '' },
  codex: { file: null, text: '-c', textPrefix: 'developer_instructions=' },
  claude: { file: '--append-system-prompt-file', text: '--append-system-prompt', textPrefix: '' },
};

// Capability lookup: the verified trusted channel for a harness id, or null
// when the harness must not receive system prompt text.
function trustedSystemChannel(id) {
  if (!Object.prototype.hasOwnProperty.call(SYSTEM_PROMPT_CHANNELS, id)) {
    throw new Error(`unknown harness id: ${id}`);
  }
  return SYSTEM_PROMPT_CHANNELS[id];
}

function hasValue(value) {
  return typeof value === 'string' && value.length > 0;
}

// Write the trusted system prompt to a router-owned file and return its path.
// The file name is a content hash: it never carries policy text, and equal
// policies reuse one file. The directory and file get owner-only permissions.
// Callers own the directory lifetime; the adapter layer never deletes it.
function writeSystemPromptFile(systemPrompt, dir) {
  if (!hasValue(systemPrompt)) {
    throw new TypeError('systemPrompt must be a non-empty string');
  }
  if (!hasValue(dir)) {
    throw new TypeError('dir must be a non-empty string');
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const digest = crypto.createHash('sha256').update(systemPrompt, 'utf8').digest('hex').slice(0, 16);
  const file = path.join(dir, `system-prompt-${digest}.md`);
  fs.writeFileSync(file, systemPrompt, { encoding: 'utf8', mode: 0o600 });
  return file;
}

// Content is either a plain string (pi user messages) or a list of blocks
// that carry text in items with type "text" (vibe content parts, pi and
// claude content blocks).
function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

class BaseHarness {
  constructor(id) {
    this.id = id;
    this.sessionId = null;
    this.systemPromptChannel = trustedSystemChannel(id);
  }

  // The argv fragment that carries the trusted system prompt through the
  // harness's native channel, or null when ctx carries none. A router-owned
  // file (ctx.systemPromptFile) is preferred over inline text
  // (ctx.systemPrompt). Throws when the harness has no verified trusted
  // channel: the policy must never fall back into the user prompt, and the
  // error message never contains the policy body.
  systemPromptArgs(ctx) {
    const text = ctx.systemPrompt;
    const file = ctx.systemPromptFile;
    if (text !== undefined && text !== null && typeof text !== 'string') {
      throw new TypeError('systemPrompt must be a string when set');
    }
    if (file !== undefined && file !== null && typeof file !== 'string') {
      throw new TypeError('systemPromptFile must be a string when set');
    }
    const hasText = typeof text === 'string' && text.length > 0;
    const hasFile = typeof file === 'string' && file.length > 0;
    // No policy in ctx: every existing plan stays byte-for-byte unchanged.
    if (!hasText && !hasFile) return null;
    if (!this.systemPromptChannel) {
      throw new Error(`harness "${this.id}" has no verified trusted system channel; refusing the system prompt`);
    }
    // A router-owned file is preferred: it keeps the policy body off the
    // command line, out of process listings, and out of logs.
    if (hasFile && this.systemPromptChannel.file) {
      if (!fs.existsSync(file)) {
        throw new Error(`system prompt file does not exist: ${file}`);
      }
      return [this.systemPromptChannel.file, file];
    }
    // A file without a file channel is refused, never silently dropped and
    // never prefixed to the user prompt. With inline text available, the
    // verified text channel carries the policy instead.
    if (hasFile && !hasText) {
      throw new Error(`harness "${this.id}" has no verified file channel for the system prompt; refusing systemPromptFile without systemPrompt text`);
    }
    return [this.systemPromptChannel.text, this.systemPromptChannel.textPrefix + text];
  }

  // Errors the harness reported on its own output stream (API errors,
  // failed results). Kept apart from assistant text: they never become a
  // report. Deduplicated, in arrival order.
  recordError(text) {
    if (typeof text !== 'string' || !text.trim()) return;
    if (!this.streamErrors) this.streamErrors = [];
    const t = text.trim();
    if (!this.streamErrors.includes(t) && this.streamErrors.length < 5) this.streamErrors.push(t);
  }

  errorText() {
    return this.streamErrors && this.streamErrors.length ? this.streamErrors.join('\n') : null;
  }

  // First session id seen on the stream wins.
  captureSessionId(id) {
    if (this.sessionId === null && typeof id === 'string' && id.length > 0) {
      this.sessionId = id;
    }
  }

  entry(role, text) {
    return { type: 'message', role, text, sessionId: this.sessionId, at: Date.now() };
  }

  // Only pi accumulates a partial message; the other adapters stream
  // complete messages per event and have nothing to flush.
  finalize() {
    return null;
  }

  // Default for harnesses without a native time limit: the server kills
  // the child process, so a SIGTERM death means the time limit hit.
  outcome(code, signal) {
    if (code === 0) return 'ok';
    if (signal === 'SIGTERM') return 'timeout';
    return 'fail';
  }
}

class VibeHarness extends BaseHarness {
  // The vibe CLI has no effort flag: the effort field is accepted and ignored.
  supportsNativeTimeLimit = true;

  buildRun(ctx) {
    const systemArgs = this.systemPromptArgs(ctx);
    const args = [];
    if (ctx.sessionId) args.push('--resume', ctx.sessionId);
    if (ctx.workdir) args.push('--workdir', ctx.workdir);
    args.push('--trust', '--agent', 'accept-edits', '--output', 'streaming',
      '--time-limit', String(ctx.timeLimitSec));
    if (ctx.autoApprove) args.push('--auto-approve');
    args.push('-p', ctx.prompt);
    if (systemArgs) args.push(...systemArgs);
    const env = {};
    if (ctx.model) env.VIBE_ACTIVE_MODEL = ctx.model;
    // vibe takes the work directory through --workdir, so no cwd.
    return { cmd: 'vibe', args, env };
  }

  normalize(obj) {
    if (!obj || typeof obj !== 'object' || obj.type !== 'message') return null;
    this.captureSessionId(obj.sessionId);
    const text = textFromContent(obj.content);
    if (!text) return null;
    return this.entry(typeof obj.role === 'string' && obj.role.length > 0 ? obj.role : null, text);
  }

  outcome(code) {
    if (code === 0) return 'ok';
    if (code === 3) return 'timeout';
    return 'fail';
  }
}

// pi accepts these thinking levels verbatim; anything else maps to "medium".
const PI_EFFORT_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

class PiHarness extends BaseHarness {
  supportsNativeTimeLimit = false;

  constructor(id) {
    super(id);
    this.pendingTextBlocks = new Map();
  }

  buildRun(ctx) {
    const systemArgs = this.systemPromptArgs(ctx);
    const args = ctx.sessionId
      ? ['--session-id', ctx.sessionId]
      : ['--session-dir', path.join(ctx.workdir, 'sessions')];
    args.push('-p', ctx.prompt, '--mode', 'json');
    // Without a model pi uses its own configured default.
    if (ctx.model) args.push('--model', ctx.model);
    args.push('--thinking', PI_EFFORT_LEVELS.has(ctx.effort) ? ctx.effort : 'medium');
    if (systemArgs) args.push(...systemArgs);
    return { cmd: 'pi', args, env: {}, cwd: ctx.workdir };
  }

  normalize(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.type === 'session') {
      // Header event: carries the session id in "id", no message text.
      this.captureSessionId(obj.id);
    } else if (obj.type === 'message_update') {
      const event = obj.assistantMessageEvent;
      if (event && (event.type === 'text_delta' || event.type === 'text_end')) {
        const index = Number.isInteger(event.contentIndex) ? event.contentIndex : 0;
        if (event.type === 'text_delta' && typeof event.delta === 'string') {
          this.pendingTextBlocks.set(index, (this.pendingTextBlocks.get(index) || '') + event.delta);
        } else if (event.type === 'text_end' && typeof event.content === 'string') {
          // text_end content is authoritative for this block.
          this.pendingTextBlocks.set(index, event.content);
        }
      }
    } else if (obj.type === 'message_end') {
      const message = obj.message || {};
      if (message.stopReason === 'error') {
        this.recordError(typeof message.errorMessage === 'string' && message.errorMessage
          ? message.errorMessage : 'pi reported an error without a message');
      }
      // message_end is authoritative, including when it contains no text.
      // Never flush the deltas again after a completed message.
      this.pendingTextBlocks.clear();
      const text = textFromContent(message.content);
      if (!text) return null;
      return this.entry(typeof message.role === 'string' && message.role.length > 0
        ? message.role : null, text);
    }
    return null;
  }

  // The stream can end without a message_end event (kill, crash); flush
  // text blocks from assistantMessageEvent, using each text_end value as
  // authoritative. Other event types never enter this partial assistant buffer.
  finalize() {
    if (!this.pendingTextBlocks.size) return null;
    const text = [...this.pendingTextBlocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, value]) => value)
      .join('');
    this.pendingTextBlocks.clear();
    return text ? this.entry('assistant', text) : null;
  }
}

class CodexHarness extends BaseHarness {
  supportsNativeTimeLimit = false;

  buildRun(ctx) {
    const systemArgs = this.systemPromptArgs(ctx);
    const flags = ['--json', '-C', ctx.workdir];
    // Without a model codex uses its own configured default.
    if (ctx.model) flags.push('--model', ctx.model);
    flags.push('-c', 'model_reasoning_effort=' + ctx.effort);
    if (ctx.autoApprove) flags.push('--full-auto');
    // The developer_instructions assignment stays one argv element after its
    // own -c flag, so multiline text, quotes, and shell-like characters pass
    // through verbatim: the child process is spawned without a shell.
    if (systemArgs) flags.push(...systemArgs);
    const args = ctx.sessionId
      ? ['exec', 'resume', ctx.sessionId, ...flags]
      : ['exec', ...flags];
    args.push(ctx.prompt);
    // codex takes the work directory through -C, so no cwd.
    return { cmd: 'codex', args, env: {} };
  }

  normalize(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.type === 'thread.started') {
      // The thread start event carries the session id: newer Codex builds
      // use "session_id", older ones "thread_id".
      this.captureSessionId(obj.session_id !== undefined ? obj.session_id : obj.thread_id);
    } else if (obj.type === 'error') {
      this.recordError(obj.message);
    } else if (obj.type === 'turn.failed') {
      this.recordError(obj.error && obj.error.message);
    } else if (obj.type === 'item.completed' && obj.item && obj.item.type === 'agent_message') {
      // Codex agent_message is an assistant event when the schema omits role.
      // Reject any explicit contradictory role instead of rewriting it.
      const roleFields = [obj.role, obj.item.role].filter((role) => role !== undefined);
      if (roleFields.some((role) => role !== 'assistant')) return null;
      const text = typeof obj.item.text === 'string' ? obj.item.text : '';
      if (text) return this.entry('assistant', text);
    }
    return null;
  }
}

// Claude Code's --effort accepts the router levels verbatim; anything else
// maps to "medium".
const CLAUDE_EFFORT_LEVELS = new Set(['low', 'medium', 'high']);

class ClaudeHarness extends BaseHarness {
  supportsNativeTimeLimit = false;

  buildRun(ctx) {
    const systemArgs = this.systemPromptArgs(ctx);
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    // Without a model the CLI uses its own configured default.
    if (ctx.model) args.push('--model', ctx.model);
    args.push('--dangerously-skip-permissions',
      '--effort', CLAUDE_EFFORT_LEVELS.has(ctx.effort) ? ctx.effort : 'medium');
    if (ctx.sessionId) args.push('--resume', ctx.sessionId);
    if (systemArgs) args.push(...systemArgs);
    // The prompt goes last, after "--": the CLI parses an argument that
    // starts with "-" (the planner turn wrapper starts with "---") as an
    // unknown option and exits.
    args.push('--', ctx.prompt);
    return { cmd: 'claude', args, env: {}, cwd: ctx.workdir };
  }

  normalize(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.type === 'system' && obj.subtype === 'init') {
      // Init event: carries the session id, no message text.
      this.captureSessionId(obj.session_id);
    } else if (obj.type === 'assistant' && obj.message
      && (obj.is_api_error_message === true || (typeof obj.error === 'string' && obj.error))) {
      // API errors (unknown model, auth, rate limit) arrive as a synthetic
      // assistant message. Its text describes the error: record it, and
      // never pass it on as assistant output.
      this.captureSessionId(obj.session_id);
      this.recordError(textFromContent(obj.message.content) || obj.error);
    } else if (obj.type === 'result' && obj.is_error === true) {
      // The final result marks the whole run failed.
      this.resultIsError = true;
      const errors = Array.isArray(obj.errors) ? obj.errors.filter((e) => typeof e === 'string') : [];
      this.recordError(typeof obj.result === 'string' && obj.result ? obj.result
        : errors.length ? errors.join('\n') : `claude result: ${obj.subtype || 'error'}`);
    } else if (obj.type === 'assistant' && obj.message) {
      // Claude's outer assistant event implies assistant only when the nested
      // message does not provide a contradictory role.
      const roleFields = [obj.role, obj.message.role].filter((role) => role !== undefined);
      if (roleFields.some((role) => role !== 'assistant')) return null;
      this.captureSessionId(obj.session_id);
      const text = textFromContent(obj.message.content);
      if (text) return this.entry('assistant', text);
    }
    return null;
  }

  // A result marked is_error fails the run even when the CLI exits 0.
  outcome(code, signal) {
    const base = super.outcome(code, signal);
    return base === 'ok' && this.resultIsError ? 'fail' : base;
  }
}

const ADAPTERS = {
  vibe: VibeHarness,
  pi: PiHarness,
  codex: CodexHarness,
  claude: ClaudeHarness,
};

function createHarness(id) {
  const Adapter = ADAPTERS[id];
  if (!Adapter) throw new Error(`unknown harness id: ${id}`);
  return new Adapter(id);
}

module.exports = { HARNESS_IDS, createHarness, trustedSystemChannel, writeSystemPromptFile };
