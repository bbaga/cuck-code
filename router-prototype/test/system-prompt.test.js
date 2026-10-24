'use strict';

// Trusted system prompt channel tests: the router-owned planner policy must
// travel through a harness's verified native channel, never through the user
// prompt, and never through a harness without a verified channel.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { HARNESS_IDS, createHarness, trustedSystemChannel, writeSystemPromptFile } = require('../harness');
const { planPlannerRun, planWorkerRun } = require('../spawn-plan');
const { resolvePipeline } = require('../pipeline-config');

// The user prompt stays byte-for-byte identical, so it carries characters
// that any prefixing or escaping mistake would change.
const USER_PROMPT = 'Implement the thing\nwith "quotes",\ttabs and unicode \u2713';
// The policy body must never appear in a user prompt, an env value, or an
// error message, so the tests search for this marker.
const POLICY = 'ROUTER POLICY: plan only. Never edit application code.';

const BASE_CTX = {
  phase: 'planner',
  prompt: USER_PROMPT,
  workdir: '/tmp/work',
  sessionId: null,
  model: 'model-x',
  effort: 'medium',
  timeLimitSec: 120,
  autoApprove: false,
};

function ctxWith(overrides) {
  return { ...BASE_CTX, ...overrides };
}

function tmpPolicyFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return writeSystemPromptFile(POLICY, dir);
}

// The value that carries the user prompt in a plan: the -p value for vibe,
// pi, and claude, the trailing positional for codex.
function userPromptInPlan(plan) {
  if (plan.cmd === 'codex') return plan.args[plan.args.length - 1];
  const i = plan.args.indexOf('-p');
  assert.notEqual(i, -1, 'expected a -p flag');
  return plan.args[i + 1];
}

function flagValue(plan, flag) {
  const i = plan.args.indexOf(flag);
  assert.notEqual(i, -1, `expected the ${flag} flag`);
  return plan.args[i + 1];
}

test('capability: pi and claude have verified channels, vibe and codex have none', () => {
  assert.deepEqual(trustedSystemChannel('pi'),
    { file: '--append-system-prompt', text: '--append-system-prompt' });
  assert.deepEqual(trustedSystemChannel('claude'),
    { file: '--append-system-prompt-file', text: '--append-system-prompt' });
  assert.equal(trustedSystemChannel('vibe'), null);
  assert.equal(trustedSystemChannel('codex'), null);
  assert.throws(() => trustedSystemChannel('nope'), /unknown harness id/);
  for (const id of HARNESS_IDS) {
    const adapter = createHarness(id);
    assert.deepEqual(adapter.systemPromptChannel, trustedSystemChannel(id));
  }
});

for (const sessionId of [null, 'sess-1']) {
  const mode = sessionId ? 'resumed' : 'fresh';

  test(`pi ${mode} plan carries the policy through --append-system-prompt with the router-owned file`, (t) => {
    const file = tmpPolicyFile(t);
    const plan = createHarness('pi').buildRun(ctxWith({ systemPrompt: POLICY, systemPromptPath: file, sessionId }));
    assert.equal(flagValue(plan, '--append-system-prompt'), file);
    assert.equal(userPromptInPlan(plan), USER_PROMPT);
    assert.ok(!plan.args.includes(POLICY), 'policy body must not appear inline');
    for (const value of Object.values(plan.env)) {
      assert.ok(!value.includes(POLICY), 'policy body must not appear in env');
    }
  });

  test(`claude ${mode} plan carries the policy through --append-system-prompt-file`, (t) => {
    const file = tmpPolicyFile(t);
    const plan = createHarness('claude').buildRun(ctxWith({ systemPrompt: POLICY, systemPromptPath: file, sessionId }));
    assert.equal(flagValue(plan, '--append-system-prompt-file'), file);
    assert.equal(userPromptInPlan(plan), USER_PROMPT);
    assert.ok(!plan.args.includes(POLICY), 'policy body must not appear inline');
    for (const value of Object.values(plan.env)) {
      assert.ok(!value.includes(POLICY), 'policy body must not appear in env');
    }
  });

  test(`pi ${mode} plan falls back to the native inline text form without a file`, () => {
    const plan = createHarness('pi').buildRun(ctxWith({ systemPrompt: POLICY, sessionId }));
    assert.equal(flagValue(plan, '--append-system-prompt'), POLICY);
    assert.equal(userPromptInPlan(plan), USER_PROMPT);
  });

  test(`claude ${mode} plan falls back to the native inline text form without a file`, () => {
    const plan = createHarness('claude').buildRun(ctxWith({ systemPrompt: POLICY, sessionId }));
    assert.equal(flagValue(plan, '--append-system-prompt'), POLICY);
    assert.equal(userPromptInPlan(plan), USER_PROMPT);
  });

  for (const id of ['vibe', 'codex']) {
    test(`${id} ${mode} plan fails closed instead of using user text`, () => {
      const adapter = createHarness(id);
      assert.throws(() => adapter.buildRun(ctxWith({ systemPrompt: POLICY, sessionId })),
        (err) => {
          assert.match(err.message, /no verified trusted system channel/);
          // The failure must not leak the policy body.
          assert.ok(!err.message.includes(POLICY));
          return true;
        });
      // The file-only form fails closed too.
      assert.throws(() => adapter.buildRun(ctxWith({ systemPromptPath: '/tmp/policy.md', sessionId })),
        /no verified trusted system channel/);
    });
  }
}

test('plans without a system prompt stay byte-for-byte unchanged', (t) => {
  const file = tmpPolicyFile(t);
  for (const id of HARNESS_IDS) {
    const plain = createHarness(id).buildRun(ctxWith({}));
    const explicit = createHarness(id).buildRun(ctxWith({
      systemPrompt: undefined, systemPromptPath: undefined,
    }));
    const empty = createHarness(id).buildRun(ctxWith({ systemPrompt: '', systemPromptPath: '' }));
    assert.deepEqual(explicit, plain);
    assert.deepEqual(empty, plain);
    assert.equal(userPromptInPlan(plain), USER_PROMPT);
    // The file path alone without policy text is still delivered: the file
    // is the policy. Only a fully absent pair changes nothing.
    const fileOnly = createHarness('pi').buildRun(ctxWith({ systemPromptPath: file }));
    assert.equal(flagValue(fileOnly, '--append-system-prompt'), file);
  }
});

test('a missing system prompt file fails the plan instead of dropping the policy', () => {
  assert.throws(() => createHarness('pi').buildRun(ctxWith({
    systemPrompt: POLICY, systemPromptPath: '/nonexistent/policy.md',
  })), /system prompt file does not exist/);
  assert.throws(() => createHarness('claude').buildRun(ctxWith({
    systemPrompt: POLICY, systemPromptPath: '/nonexistent/policy.md',
  })), /system prompt file does not exist/);
});

test('invalid system prompt types are rejected', () => {
  assert.throws(() => createHarness('pi').buildRun(ctxWith({ systemPrompt: 42 })),
    /systemPrompt must be a string/);
  assert.throws(() => createHarness('pi').buildRun(ctxWith({ systemPrompt: POLICY, systemPromptPath: 42 })),
    /systemPromptPath must be a string/);
});

test('writeSystemPromptFile writes an owner-only file with a content-hash name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-policy-'));
  try {
    const file = writeSystemPromptFile(POLICY, dir);
    assert.equal(fs.readFileSync(file, 'utf8'), POLICY);
    assert.equal(path.dirname(file), dir);
    assert.match(path.basename(file), /^system-prompt-[0-9a-f]{16}\.md$/);
    assert.ok(!path.basename(file).includes('POLICY'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // Equal content reuses one file; different content gets another file.
    assert.equal(writeSystemPromptFile(POLICY, dir), file);
    const other = writeSystemPromptFile(POLICY + '\nMore.', dir);
    assert.notEqual(other, file);
    // A missing directory is created.
    const nested = writeSystemPromptFile(POLICY, path.join(dir, 'a', 'b'));
    assert.equal(fs.readFileSync(nested, 'utf8'), POLICY);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => writeSystemPromptFile('', '/tmp/x'), /non-empty string/);
  assert.throws(() => writeSystemPromptFile(POLICY, ''), /non-empty string/);
});

test('spawn plans pass the trusted channel through for planners and workers', (t) => {
  const file = tmpPolicyFile(t);
  const plannerCfg = { ...resolvePipeline({}, {}).planner, harness: 'pi' };
  const plan = planPlannerRun(plannerCfg, {
    prompt: USER_PROMPT, workdir: '/tmp/line', sessionId: null, autoApprove: true,
    systemPrompt: POLICY, systemPromptPath: file,
  });
  assert.equal(flagValue(plan, '--append-system-prompt'), file);
  assert.equal(userPromptInPlan(plan), USER_PROMPT);

  const workerCfg = { ...resolvePipeline({}, {}).implementor, harness: 'claude' };
  const workerPlan = planWorkerRun(workerCfg, {
    phase: 'implementor', prompt: USER_PROMPT, workdir: '/tmp/wt',
    sessionId: 'sess-9', autoApprove: true, systemPrompt: POLICY, systemPromptPath: file,
  });
  assert.equal(flagValue(workerPlan, '--append-system-prompt-file'), file);
  assert.equal(userPromptInPlan(workerPlan), USER_PROMPT);

  // The default planner harness (vibe) has no verified channel: planning a
  // system prompt run fails closed instead of falling back.
  assert.throws(() => planPlannerRun(resolvePipeline({}, {}).planner, {
    prompt: USER_PROMPT, workdir: '/tmp/line', sessionId: null, autoApprove: true,
    systemPrompt: POLICY,
  }), /no verified trusted system channel/);
});
