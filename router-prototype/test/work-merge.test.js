'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { captureClaim, cleanRepoUrl, stableId, transition, verifyMerge } = require('../work-merge');

const base = () => ({ version: 1, revision: 2, claims: [{ id: 'c1', revision: 3, commit: 'a'.repeat(40), createdAt: new Date().toISOString() }], requests: [], archive: [], events: [], outbox: [], eventCursor: 4 });

test('checks stable commit ancestry through git and rejects untrusted repositories', async () => {
  assert.equal(cleanRepoUrl('git@github.com:owner/repo.git'), 'https://github.com/owner/repo.git');
  assert.throws(() => cleanRepoUrl('https://evil.example/owner/repo'), /Untrusted/);
  const result = await verifyMerge({ repoPath: '/missing', repositoryUrl: 'https://github.com/o/r', commit: 'a'.repeat(40), targetBranch: 'main', strategy: 'merge' });
  assert.equal(result.verified, false);
});

test('requires verified pull-request evidence for squash and rebase strategies', async () => {
  // A failed git check must remain unverified, regardless of supplied pull-request data.
  const result = await verifyMerge({ repoPath: '/missing', repositoryUrl: 'https://github.com/o/r', commit: 'a'.repeat(40), targetBranch: 'main', strategy: 'squash', pullRequest: 4, checkPullRequest: async () => ({ verified: true, merged: true, base: 'main', number: 4 }) });
  assert.equal(result.verified, false);
});

test('verifies ancestry for the exact claim commit on the default branch', async () => {
  const calls = [];
  const gitCommand = async (_repo, args) => {
    calls.push(args);
    if (args[0] === 'remote') return 'https://github.com/o/r.git';
    if (args[0] === 'ls-remote') return 'ref: refs/heads/main\tHEAD\n' + 'b'.repeat(40) + '\tHEAD';
    if (args[0] === 'merge-base') {
      assert.equal(args[2], 'a'.repeat(40));
      assert.equal(args[3], 'refs/remotes/origin/main');
      return '';
    }
    return '';
  };
  const result = await verifyMerge({ repoPath: '/repo', repositoryUrl: 'https://github.com/o/r', commit: 'a'.repeat(40), targetBranch: 'main', strategy: 'merge', gitCommand });
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.equal(calls.some(args => args[0] === 'fetch'), true);
});

test('accepts only verified pull-request evidence for the same repo, branch, and commit', async () => {
  const gitCommand = async (_repo, args) => args[0] === 'remote' ? 'https://github.com/o/r.git' : args[0] === 'ls-remote' ? 'ref: refs/heads/main\tHEAD\n' + 'b'.repeat(40) + '\tHEAD' : '';
  const args = { repoPath: '/repo', repositoryUrl: 'https://github.com/o/r', commit: 'a'.repeat(40), targetBranch: 'main', strategy: 'squash', pullRequest: 8, gitCommand };
  const evidence = { verified: true, merged: true, base: 'main', number: 8, repositoryUrl: 'https://github.com/o/r.git', commit: 'a'.repeat(40) };
  assert.equal((await verifyMerge({ ...args, checkPullRequest: async () => evidence })).verified, true);
  for (const invalid of [
    { ...evidence, repositoryUrl: 'https://github.com/other/r.git' },
    { ...evidence, base: 'release' },
    { ...evidence, commit: 'c'.repeat(40) },
    { ...evidence, verified: false }
  ]) assert.equal((await verifyMerge({ ...args, checkPullRequest: async () => invalid })).verified, false);
});

test('leaves failed checks and stale claim results unchanged', () => {
  const snapshot = base();
  const captured = captureClaim(snapshot, 'c1');
  assert.deepEqual(transition(snapshot, captured, { verified: false }), { ok: false, reason: 'unverified' });
  const changed = structuredClone(snapshot);
  changed.claims[0].revision++;
  assert.deepEqual(transition(changed, captured, { verified: true }), { ok: false, reason: 'stale_claim' });
});

test('archives once with stable event identifiers, cursor replay, and dependent notices', () => {
  const snapshot = base();
  const captured = captureClaim(snapshot, 'c1');
  const options = { now: Date.now(), dependentNoticeIds: ['n1', 'n1', 'n2'] };
  const first = transition(snapshot, captured, { verified: true, strategy: 'merge' }, options);
  const replay = transition(snapshot, captured, { verified: true, strategy: 'merge' }, options);
  assert.equal(first.snapshot.events[0].id, stableId('c1:3:' + 'a'.repeat(40) + ':merged'));
  assert.equal(first.snapshot.events[0].cursor, 5);
  assert.equal(first.snapshot.outbox.length, 2);
  assert.equal(replay.snapshot.events[0].id, first.snapshot.events[0].id);
  assert.equal(transition(first.snapshot, captured, { verified: true }, options).reason, 'stale_claim');
});
