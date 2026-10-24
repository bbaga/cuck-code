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
// with role one of "assistant", "user", "system", or null for event
// lines that carry no message text.

const path = require('path');

const HARNESS_IDS = ['vibe', 'pi', 'codex', 'claude'];

const ROLES = new Set(['assistant', 'user', 'system']);

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
    const args = [];
    if (ctx.sessionId) args.push('--resume', ctx.sessionId);
    if (ctx.workdir) args.push('--workdir', ctx.workdir);
    args.push('--trust', '--agent', 'accept-edits', '--output', 'streaming',
      '--time-limit', String(ctx.timeLimitSec));
    if (ctx.autoApprove) args.push('--auto-approve');
    args.push('-p', ctx.prompt);
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
    return this.entry(ROLES.has(obj.role) ? obj.role : 'assistant', text);
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
    const args = ctx.sessionId
      ? ['--session-id', ctx.sessionId]
      : ['--session-dir', path.join(ctx.workdir, 'sessions')];
    args.push('-p', ctx.prompt, '--mode', 'json', '--model', ctx.model,
      '--thinking', PI_EFFORT_LEVELS.has(ctx.effort) ? ctx.effort : 'medium');
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
      // message_end is authoritative, including when it contains no text.
      // Never flush the deltas again after a completed message.
      this.pendingTextBlocks.clear();
      const text = textFromContent(message.content);
      if (!text) return null;
      return this.entry(ROLES.has(message.role) ? message.role : 'assistant', text);
    }
    return null;
  }

  // The stream can end without a message_end event (kill, crash); flush
  // text blocks, using each text_end content as its authoritative value.
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
    const flags = ['--json', '-C', ctx.workdir, '--model', ctx.model,
      '-c', 'model_reasoning_effort=' + ctx.effort];
    if (ctx.autoApprove) flags.push('--full-auto');
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
    } else if (obj.type === 'item.completed' && obj.item && obj.item.type === 'agent_message') {
      const text = typeof obj.item.text === 'string' ? obj.item.text : '';
      if (text) return this.entry('assistant', text);
    }
    return null;
  }
}

const CLAUDE_THINKING_TOKENS = { low: 0, medium: 8192, high: 31999 };

class ClaudeHarness extends BaseHarness {
  supportsNativeTimeLimit = false;

  buildRun(ctx) {
    const tokens = Object.prototype.hasOwnProperty.call(CLAUDE_THINKING_TOKENS, ctx.effort)
      ? CLAUDE_THINKING_TOKENS[ctx.effort]
      : CLAUDE_THINKING_TOKENS.medium;
    const args = ['-p', ctx.prompt, '--output-format', 'stream-json', '--verbose',
      '--model', ctx.model, '--dangerously-skip-permissions',
      '--max-thinking-tokens', String(tokens)];
    if (ctx.sessionId) args.push('--resume', ctx.sessionId);
    return { cmd: 'claude', args, env: {}, cwd: ctx.workdir };
  }

  normalize(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.type === 'system' && obj.subtype === 'init') {
      // Init event: carries the session id, no message text.
      this.captureSessionId(obj.session_id);
    } else if (obj.type === 'assistant' && obj.message) {
      this.captureSessionId(obj.session_id);
      const text = textFromContent(obj.message.content);
      if (text) return this.entry('assistant', text);
    }
    return null;
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

module.exports = { HARNESS_IDS, createHarness };
