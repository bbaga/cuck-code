'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { HARNESS_IDS, createHarness } = require('../harness');

const fixture = (name) => fs
  .readFileSync(path.join(__dirname, 'fixtures', `${name}.jsonl`), 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const CTX = {
  phase: 'work',
  prompt: 'Do the task',
  workdir: '/tmp/work',
  sessionId: null,
  model: 'model-x',
  effort: 'medium',
  timeLimitSec: 120,
  autoApprove: false,
};

function assertEntry(entry, role, text, sessionId) {
  assert.ok(entry, 'expected a common entry, got null');
  assert.deepStrictEqual(Object.keys(entry).sort(), ['at', 'role', 'sessionId', 'text', 'type']);
  assert.strictEqual(entry.type, 'message');
  assert.strictEqual(entry.role, role);
  assert.strictEqual(entry.text, text);
  assert.strictEqual(entry.sessionId, sessionId);
  assert.strictEqual(typeof entry.at, 'number');
}

const outcomeCases = (h, timeoutArg) => {
  assert.strictEqual(h.outcome(0, null), 'ok');
  assert.strictEqual(h.outcome(...timeoutArg), 'timeout');
  assert.strictEqual(h.outcome(1, null), 'fail');
};

test('exports, factory errors, and independent instances', () => {
  assert.deepStrictEqual(HARNESS_IDS, ['vibe', 'pi', 'codex', 'claude']);
  assert.throws(() => createHarness('nope'), /unknown harness id/);
  const a = createHarness('pi');
  const b = createHarness('pi');
  a.normalize(fixture('pi')[0]);
  assert.strictEqual(a.sessionId, 'pi-session-1');
  assert.strictEqual(b.sessionId, null);
  assert.strictEqual(a.id, 'pi');
  assert.strictEqual(b.id, 'pi');
});

// --- vibe ---

test('vibe buildRun: fresh and resumed argv, env, cwd, effort ignored', () => {
  const h = createHarness('vibe');
  const run = h.buildRun({ ...CTX, timeLimitSec: 90, autoApprove: true });
  assert.strictEqual(run.cmd, 'vibe');
  assert.deepStrictEqual(run.args, [
    '--workdir', '/tmp/work',
    '--trust', '--agent', 'accept-edits',
    '--output', 'streaming', '--time-limit', '90',
    '--auto-approve', '-p', 'Do the task',
  ]);
  assert.deepStrictEqual(run.env, { VIBE_ACTIVE_MODEL: 'model-x' });
  assert.strictEqual(run.cwd, undefined);
  const resumed = h.buildRun({ ...CTX, sessionId: 's1' });
  assert.deepStrictEqual(resumed.args.slice(0, 2), ['--resume', 's1']);
  assert.ok(!resumed.args.includes('--auto-approve'));
  assert.deepStrictEqual(h.buildRun({ ...CTX, model: null }).env, {});
  assert.deepStrictEqual(
    h.buildRun({ ...CTX, effort: 'low' }).args,
    h.buildRun({ ...CTX, effort: 'high' }).args
  );
});

test('vibe outcome and normalize on fixture lines', () => {
  const h = createHarness('vibe');
  assert.strictEqual(h.supportsNativeTimeLimit, true);
  outcomeCases(h, [3, null]);
  const lines = fixture('vibe');
  assertEntry(h.normalize(lines[0]), 'assistant', 'Hello from vibe', 'vibe-session-1');
  assertEntry(h.normalize(lines[1]), 'assistant', 'Second part', 'vibe-session-1');
  assert.strictEqual(h.normalize(lines[2]), null);
  assert.strictEqual(h.finalize(), null);
});

// --- pi ---

test('pi buildRun: fresh and resumed argv, cwd, effort mapping', () => {
  const h = createHarness('pi');
  const run = h.buildRun(CTX);
  assert.strictEqual(run.cmd, 'pi');
  assert.deepStrictEqual(run.args, [
    '--session-dir', '/tmp/work/sessions',
    '-p', 'Do the task', '--mode', 'json', '--model', 'model-x', '--thinking', 'medium',
  ]);
  assert.deepStrictEqual(run.env, {});
  assert.strictEqual(run.cwd, '/tmp/work');
  assert.deepStrictEqual(
    h.buildRun({ ...CTX, sessionId: 's1' }).args.slice(0, 2),
    ['--session-id', 's1']
  );
  const thinking = (effort) => {
    const args = h.buildRun({ ...CTX, effort }).args;
    return args[args.indexOf('--thinking') + 1];
  };
  const cases = {
    low: 'low', medium: 'medium', high: 'high',
    minimal: 'minimal', xhigh: 'xhigh', max: 'max',
    bogus: 'medium', undefined: 'medium',
  };
  for (const [effort, level] of Object.entries(cases)) {
    assert.strictEqual(thinking(effort === 'undefined' ? undefined : effort), level);
  }
});

test('pi outcome, delta accumulation, and finalize flush', () => {
  const h = createHarness('pi');
  assert.strictEqual(h.supportsNativeTimeLimit, false);
  outcomeCases(h, [null, 'SIGTERM']);
  const lines = fixture('pi');
  for (const line of lines) assert.strictEqual(h.normalize(line), null);
  assert.strictEqual(h.sessionId, 'pi-session-1');
  const entry = h.finalize();
  assertEntry(entry, 'assistant', 'Hello from pi', 'pi-session-1');
  assert.strictEqual(h.finalize(), null);
  h.normalize({
    type: 'message_update', usage: {},
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial' },
  });
  const done = h.normalize({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'final text' }] },
  });
  assertEntry(done, 'assistant', 'final text', 'pi-session-1');
  assert.strictEqual(h.finalize(), null);

  h.normalize({ type: 'message_update', assistantMessageEvent: {
    type: 'text_delta', contentIndex: 0, delta: 'must not leak',
  } });
  assert.strictEqual(h.normalize({ type: 'message_end', message: {
    role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }],
  } }), null);
  assert.strictEqual(h.finalize(), null, 'completed empty message clears partial deltas');

  h.normalize({ type: 'message_update', assistantMessageEvent: {
    type: 'text_delta', contentIndex: 0, delta: 'partial',
  } });
  h.normalize({ type: 'message_update', assistantMessageEvent: {
    type: 'text_end', contentIndex: 0, content: 'authoritative ✓',
  } });
  assertEntry(h.finalize(), 'assistant', 'authoritative ✓', 'pi-session-1');
});

// --- codex ---

test('codex buildRun: fresh, resumed, and --full-auto argv', () => {
  const h = createHarness('codex');
  const run = h.buildRun(CTX);
  assert.strictEqual(run.cmd, 'codex');
  assert.deepStrictEqual(run.args, [
    'exec', '--json', '-C', '/tmp/work',
    '--model', 'model-x', '-c', 'model_reasoning_effort=medium', 'Do the task',
  ]);
  assert.deepStrictEqual(run.env, {});
  assert.strictEqual(run.cwd, undefined);
  assert.deepStrictEqual(h.buildRun({ ...CTX, autoApprove: true }).args, [
    'exec', '--json', '-C', '/tmp/work',
    '--model', 'model-x', '-c', 'model_reasoning_effort=medium', '--full-auto', 'Do the task',
  ]);
  assert.deepStrictEqual(h.buildRun({ ...CTX, sessionId: 's1', effort: 'high' }).args, [
    'exec', 'resume', 's1', '--json', '-C', '/tmp/work',
    '--model', 'model-x', '-c', 'model_reasoning_effort=high', 'Do the task',
  ]);
});

test('codex outcome and normalize on fixture lines', () => {
  const h = createHarness('codex');
  assert.strictEqual(h.supportsNativeTimeLimit, false);
  outcomeCases(h, [null, 'SIGTERM']);
  const lines = fixture('codex');
  assert.strictEqual(h.normalize(lines[0]), null);
  assert.strictEqual(h.sessionId, 'codex-session-1');
  assert.strictEqual(h.normalize(lines[1]), null);
  assertEntry(h.normalize(lines[2]), 'assistant', 'Hello from codex', 'codex-session-1');
  assertEntry(h.normalize(lines[3]), 'assistant', 'Second line', 'codex-session-1');
  assert.strictEqual(h.normalize(lines[4]), null);
  assert.strictEqual(h.finalize(), null);
});

// --- claude ---

test('claude buildRun: fresh and resumed argv, cwd, token map', () => {
  const h = createHarness('claude');
  const run = h.buildRun(CTX);
  assert.strictEqual(run.cmd, 'claude');
  assert.deepStrictEqual(run.args, [
    '-p', 'Do the task', '--output-format', 'stream-json', '--verbose',
    '--model', 'model-x', '--dangerously-skip-permissions',
    '--max-thinking-tokens', '8192',
  ]);
  assert.deepStrictEqual(run.env, {});
  assert.strictEqual(run.cwd, '/tmp/work');
  const tokens = (effort) => {
    const args = h.buildRun({ ...CTX, effort }).args;
    return args[args.indexOf('--max-thinking-tokens') + 1];
  };
  assert.strictEqual(tokens('low'), '0');
  assert.strictEqual(tokens('medium'), '8192');
  assert.strictEqual(tokens('high'), '31999');
  assert.deepStrictEqual(
    h.buildRun({ ...CTX, sessionId: 's1' }).args.slice(-2),
    ['--resume', 's1']
  );
});

test('claude outcome and normalize on fixture lines', () => {
  const h = createHarness('claude');
  assert.strictEqual(h.supportsNativeTimeLimit, false);
  outcomeCases(h, [null, 'SIGTERM']);
  const lines = fixture('claude');
  assert.strictEqual(h.normalize(lines[0]), null);
  assert.strictEqual(h.sessionId, 'claude-session-1');
  assertEntry(h.normalize(lines[1]), 'assistant', 'Hello from claude', 'claude-session-1');
  assertEntry(h.normalize(lines[2]), 'assistant', 'Part two', 'claude-session-1');
  assert.strictEqual(h.normalize(lines[3]), null);
  assert.strictEqual(h.finalize(), null);
});
