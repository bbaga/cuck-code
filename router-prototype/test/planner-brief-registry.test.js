'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// server.js starts a server when required, so build the function from its source.
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const start = source.indexOf('function plannerBrief(');
assert.ok(start >= 0, 'start marker "function plannerBrief(" not found in server.js');
const end = source.indexOf('\n}\n', start);
assert.ok(end > start, 'end marker "\\n}\\n" not found after plannerBrief');
const plannerBrief = new Function('WORKER_CAP', `${source.slice(start, end + 3)}\nreturn plannerBrief;`)(8);

const brief = plannerBrief('N', 'L-1', 'PROMPT', 7788);
const BEGIN = '## Work registry\n';
const FINISH = '## Container and process hygiene';
// SHA-256 of the brief text before the registry block was added (WORKER_CAP 8).
const BASELINE_SHA256 = '3687c098dfa7aab2e5cfc10f1895c10c574a1487cfc1de0b85c3674f65ebef63';

test('registry block sits between the factory protocol and the hygiene section', () => {
  const a = brief.indexOf(BEGIN);
  const b = brief.indexOf(FINISH);
  assert.ok(a > brief.indexOf('## Factory protocol'), 'registry marker missing or misplaced');
  assert.ok(b > a, 'hygiene marker must follow the registry block');
});

test('registry block names the real port, line id and endpoints', () => {
  const block = brief.slice(brief.indexOf(BEGIN), brief.indexOf(FINISH));
  for (const text of [
    'http://localhost:7788/api/registry/claims?q=',
    'http://localhost:7788/api/registry/summary',
    'http://localhost:7788/api/registry/lines/L-1/requests',
    'http://localhost:7788/api/registry/lines/L-1/claims',
    'http://localhost:7788/api/registry/events?after=',
    'untrusted', 'never approves a plan', 'Supersede', 'stale claim'
  ]) assert.ok(block.includes(text), `missing: ${text}`);
});

test('the rest of the brief is unchanged', () => {
  const a = brief.indexOf(BEGIN);
  const rest = brief.slice(0, a) + brief.slice(brief.indexOf(FINISH));
  assert.equal(crypto.createHash('sha256').update(rest).digest('hex'), BASELINE_SHA256);
  for (const text of ['PLANNER-ONLY RULES', 'Never infer approval from continue.', 'You plan and coordinate only']) {
    assert.ok(rest.includes(text), `missing: ${text}`);
  }
});
