'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { HARNESS_IDS, createHarness } = require('../harness');
const { InvocationCapture, applyCompletion, explicitVerdict } = require('../handoff');

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

test('vibe buildRun: a leading-dash prompt rides the = form of --prompt', () => {
  const h = createHarness('vibe');
  // A prompt that starts with '-' would be parsed as an unknown flag in the
  // two-argument form, so the adapter must keep it in one argv element.
  const dash = h.buildRun({ ...CTX, prompt: '--- PLANNER TURN CONTEXT ---\nDo the task' });
  assert.ok(dash.args.includes('--- PLANNER TURN CONTEXT ---\nDo the task') === false,
    'the dash-leading prompt must not ride as its own argv element');
  assert.deepStrictEqual(dash.args.slice(-1),
    ['--prompt=--- PLANNER TURN CONTEXT ---\nDo the task']);
  // A prompt without a leading dash keeps the historical argv byte for byte.
  const plain = h.buildRun({ ...CTX });
  assert.deepStrictEqual(plain.args.slice(-2), ['-p', 'Do the task']);
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

test('claude buildRun: fresh and resumed argv, cwd, effort mapping', () => {
  const h = createHarness('claude');
  const run = h.buildRun(CTX);
  assert.strictEqual(run.cmd, 'claude');
  assert.deepStrictEqual(run.args, [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--model', 'model-x', '--dangerously-skip-permissions',
    '--effort', 'medium', '--', 'Do the task',
  ]);
  assert.deepStrictEqual(run.env, {});
  assert.strictEqual(run.cwd, '/tmp/work');
  const effort = (value) => {
    const args = h.buildRun({ ...CTX, effort: value }).args;
    return args[args.indexOf('--effort') + 1];
  };
  assert.strictEqual(effort('low'), 'low');
  assert.strictEqual(effort('medium'), 'medium');
  assert.strictEqual(effort('high'), 'high');
  assert.strictEqual(effort('bogus'), 'medium');
  assert.deepStrictEqual(
    h.buildRun({ ...CTX, sessionId: 's1' }).args.slice(-4),
    ['--resume', 's1', '--', 'Do the task']
  );
});

test('claude buildRun keeps a dash-leading prompt after "--"', () => {
  // The planner turn wrapper starts with "---"; before "--" the CLI
  // rejected it as an unknown option.
  const prompt = '--- PLANNER TURN CONTEXT ---\nDo the task';
  const args = createHarness('claude').buildRun({ ...CTX, prompt }).args;
  assert.deepStrictEqual(args.slice(-2), ['--', prompt]);
  assert.strictEqual(args.indexOf(prompt), args.length - 1);
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

test('pi, codex, claude omit --model when no model is set', () => {
  for (const id of ['pi', 'codex', 'claude']) {
    for (const model of [null, undefined, '']) {
      const args = createHarness(id).buildRun({ ...CTX, model }).args;
      assert.ok(!args.includes('--model'), `${id} with model ${model}`);
      assert.ok(args.every((a) => typeof a === 'string'), `${id} argv must be strings`);
    }
  }
});

function schemaRecord(harness, role, text) {
  if (harness === 'vibe') {
    return { type: 'message', ...(role === undefined ? {} : { role }),
      content: [{ type: 'text', text }] };
  }
  if (harness === 'pi') {
    return { type: 'message_end', message: { ...(role === undefined ? {} : { role }),
      content: [{ type: 'text', text }] } };
  }
  if (harness === 'codex') {
    return { type: 'item.completed', item: { type: 'agent_message',
      ...(role === undefined ? {} : { role }), text } };
  }
  return { type: 'assistant', message: { ...(role === undefined ? {} : { role }),
    content: [{ type: 'text', text }] } };
}

const untrustedRoles = ['toolResult', 'tool', 'custom', 'unknown', 'user', 'system'];

test('Vibe and Pi preserve explicit non-assistant roles without promoting them into reports', () => {
  for (const harnessId of ['vibe', 'pi']) {
    for (const role of untrustedRoles) {
      const adapter = createHarness(harnessId);
      const entry = adapter.normalize(schemaRecord(harnessId, role, `role ${role} text`));
      assert.strictEqual(entry.role, role, `${harnessId} role ${role}`);
      const capture = new InvocationCapture();
      capture.add(entry);
      assert.strictEqual(capture.text(), '', `${harnessId} role ${role} entered report capture`);
    }
    const adapter = createHarness(harnessId);
    const missing = adapter.normalize(schemaRecord(harnessId, undefined, 'missing role text'));
    assert.strictEqual(missing.role, null, `${harnessId} missing role must remain untrusted`);
    const capture = new InvocationCapture();
    capture.add(missing);
    assert.strictEqual(capture.text(), '');

    for (const role of ['user', 'system']) {
      const transcriptEntry = createHarness(harnessId).normalize(
        schemaRecord(harnessId, role, `${role} transcript`));
      assert.strictEqual(transcriptEntry.role, role);
      assert.strictEqual(transcriptEntry.text, `${role} transcript`);
    }
  }
});

test('Codex and Claude accept schema-implied assistant events but reject contradictory roles', () => {
  for (const harnessId of ['codex', 'claude']) {
    const implicit = createHarness(harnessId).normalize(
      schemaRecord(harnessId, undefined, 'schema assistant text'));
    assertEntry(implicit, 'assistant', 'schema assistant text', null);
    for (const role of untrustedRoles) {
      const rejected = createHarness(harnessId).normalize(
        schemaRecord(harnessId, role, `must reject ${role}`));
      assert.strictEqual(rejected, null, `${harnessId} explicit ${role} role`);
      if (harnessId === 'claude') {
        const topLevelConflict = createHarness(harnessId).normalize({
          type: 'assistant', role, message: { content: [{ type: 'text', text: 'contradictory role' }] },
        });
        assert.strictEqual(topLevelConflict, null, `Claude outer ${role} role`);
      }
    }
    const explicit = createHarness(harnessId).normalize(
      schemaRecord(harnessId, 'assistant', 'explicit assistant text'));
    assertEntry(explicit, 'assistant', 'explicit assistant text', null);
  }
});

test('Pi tool completion clears pending assistant deltas before finalize', () => {
  const adapter = createHarness('pi');
  const capture = new InvocationCapture();
  adapter.normalize({ type: 'message_update', assistantMessageEvent: {
    type: 'text_delta', contentIndex: 0, delta: 'VERDICT: PASS',
  } });
  const toolEntry = adapter.normalize(schemaRecord('pi', 'toolResult', 'tool output'));
  assert.strictEqual(toolEntry.role, 'toolResult');
  capture.add(toolEntry);
  const finalized = adapter.finalize();
  if (finalized) capture.add(finalized);
  assert.strictEqual(capture.text(), '');
});

test('real outputs from every harness produce only assistant criteria and verdicts', () => {
  const records = {
    vibe: (text) => schemaRecord('vibe', 'assistant', text),
    pi: (text) => schemaRecord('pi', 'assistant', text),
    codex: (text) => schemaRecord('codex', undefined, text),
    claude: (text) => schemaRecord('claude', undefined, text),
  };
  for (const harnessId of HARNESS_IDS) {
    for (const verdict of ['PASS', 'FAIL']) {
      const adapter = createHarness(harnessId);
      const capture = new InvocationCapture();
      const entry = adapter.normalize(records[harnessId](`1. Check exact output ✓\nVERDICT: ${verdict}`));
      if (entry) capture.add(entry);
      const final = adapter.finalize();
      if (final) capture.add(final);
      const report = capture.text();
      assert.strictEqual(report, `1. Check exact output ✓\nVERDICT: ${verdict}`, `${harnessId} ${verdict}`);
      assert.strictEqual(report.trim().length > 0, true);
      assert.strictEqual(explicitVerdict(report), verdict.toLowerCase());
      const validator = { id: `v-${harnessId}`, role: 'validator', status: 'running', verdict: null };
      applyCompletion(validator, 'ok', false, report);
      assert.strictEqual(validator.verdict, verdict.toLowerCase());
    }
  }
});

test('tool PASS cannot create a verdict; assistant FAIL remains authoritative', () => {
  for (const harnessId of ['vibe', 'pi']) {
    const capture = new InvocationCapture();
    const tool = createHarness(harnessId).normalize(schemaRecord(harnessId, 'tool', 'VERDICT: PASS'));
    capture.add(tool);
    const toolOnlyReport = capture.text();
    const absentVerdict = { id: 'validator-tool-only', role: 'validator', status: 'running', verdict: null };
    applyCompletion(absentVerdict, 'ok', false, toolOnlyReport);
    assert.strictEqual(explicitVerdict(toolOnlyReport), null);
    assert.strictEqual(absentVerdict.verdict, null);

    const mixed = new InvocationCapture();
    mixed.add(createHarness(harnessId).normalize(
      schemaRecord(harnessId, 'assistant', 'Report body\nVERDICT: FAIL')));
    mixed.add(createHarness(harnessId).normalize(schemaRecord(harnessId, 'tool', 'VERDICT: PASS')));
    const assistantReport = mixed.text();
    const validator = { id: 'validator-mixed', role: 'validator', status: 'running', verdict: null };
    applyCompletion(validator, 'ok', false, assistantReport);
    assert.strictEqual(assistantReport, 'Report body\nVERDICT: FAIL');
    assert.strictEqual(validator.verdict, 'fail');
  }
});
