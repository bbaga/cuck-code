'use strict';

// Contract for REGISTRY-VIDEOS.md: the shell snippets form one coherent
// sequence. Every variable is defined before use, and evidence and inventory
// calls target the orchestration router only, never the isolated app router.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const blocks = [...fs.readFileSync(path.join(__dirname, '..', 'REGISTRY-VIDEOS.md'), 'utf8')
  .matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);

test('the guide holds the setup, registration, and cleanup snippets', () => {
  assert.ok(blocks.length >= 5);
  const script = blocks.join('\n');
  assert.match(script, /BASE=http:\/\/localhost:\$PORT/);
  assert.match(script, /ORCH=<orchestration router URL/);
  assert.match(script, /ORCH_LINE_ID=<the id of the orchestration line/);
  assert.match(script, /WORKER_ID=<validatorId from the integration start response>/);
  assert.match(script, /WORKTREE=<worktree from the integration start response>/);
  assert.match(script, /EVIDENCE_ID=<evidenceId from the registration response>/);
  assert.match(script, /kill "\$SERVER_PID"/);
});

test('every shell variable is defined before use', () => {
  const defined = new Set();
  for (const block of blocks) {
    const local = new Set();
    for (const m of block.matchAll(/(?:^|[\n;])\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=/g)) local.add(m[1]);
    for (const m of block.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g)) {
      assert.ok(defined.has(m[1]) || local.has(m[1]), `undefined variable $${m[1]}`);
    }
    for (const name of local) defined.add(name);
  }
});

test('evidence and inventory calls target the orchestration router only', () => {
  for (const block of blocks) {
    for (const line of block.split('\n')) {
      if (!/\/evidence|\/inventory/.test(line)) continue;
      assert.doesNotMatch(line, /\$BASE/, 'evidence or inventory call on the isolated router');
      if (/-X POST/.test(line)) assert.match(line, /\$ORCH\//);
    }
  }
});

test('evidence list and video calls use the orchestration line id', () => {
  for (const m of blocks.join('\n').matchAll(/\$ORCH\/api\/lines\/([A-Z_][A-Z0-9_]*)/g)) {
    assert.equal(m[1], 'ORCH_LINE_ID');
  }
});
