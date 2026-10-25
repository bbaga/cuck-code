'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../work-registry');
const { verifyMerge, recordCheck, applyMerge, purgeExpired, eventsAfter, reconcile, RETENTION_MS } = require('../work-merge');

const C1 = 'a'.repeat(40);
const C2 = 'b'.repeat(40);
const URL1 = 'https://github.com/o/r.git';
const NOW = Date.parse('2026-06-01T00:00:00Z');

function fakeGit({ origin = URL1, head = 'main', ancestor = true, fail } = {}) {
  const calls = [];
  const fn = async (_p, args) => {
    calls.push(args.join(' '));
    if (fail) throw new Error(fail);
    if (args[0] === 'remote') return origin;
    if (args[0] === 'ls-remote') return `ref: refs/heads/${head}\tHEAD\n${C1}\tHEAD`;
    if (args[0] === 'merge-base' && !ancestor) throw Object.assign(new Error('no'), { code: 1 });
    return '';
  };
  fn.calls = calls;
  return fn;
}
const base = (over = {}) => ({ repoPath: '/x', repositoryUrl: 'git@github.com:o/r', commit: C1, targetBranch: 'main', strategy: 'merge', now: NOW, gitCommand: fakeGit(), ...over });

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-'));
  const file = path.join(dir, 'reg.json');
  const store = createStore(file);
  await store.transact(0, s => {
    s.claims.push({ id: 'c1', revision: 2, commit: C1, title: 'T', ownerLineId: 'own', status: 'active' });
    s.requests.push(
      { id: 'r1', sourceLineId: 'a', targetLineId: 'own', claimId: 'c1', state: 'open', revision: 1 },
      { id: 'r2', sourceLineId: 'a', targetLineId: 'b', claimId: 'c1', state: 'open', revision: 1 },
      { id: 'r3', sourceLineId: 'z', targetLineId: 'own', claimId: 'other', state: 'open', revision: 1 });
  });
  return { store, file };
}
const cap = { id: 'c1', revision: 2, commit: C1 };
const good = { verified: true, commit: C1 };

test('verifyMerge: merge ancestry gives full evidence', async () => {
  const r = await verifyMerge(base());
  assert.deepEqual(r, { verified: true, repositoryUrl: URL1, targetBranch: 'main', defaultBranch: 'main', commit: C1, strategy: 'merge', pullRequest: null, checkedAt: new Date(NOW).toISOString() });
});

test('verifyMerge: squash uses checkPullRequest', async () => {
  const checkPullRequest = async () => ({ verified: true, merged: true, base: 'main', repositoryUrl: URL1, commit: C1, number: 7 });
  const r = await verifyMerge(base({ strategy: 'squash', checkPullRequest }));
  assert.equal(r.verified, true);
  assert.equal(r.pullRequest, 7);
  const bad = await verifyMerge(base({ strategy: 'squash', checkPullRequest: async () => ({ verified: true, merged: true, base: 'dev', repositoryUrl: URL1, commit: C1, number: 7 }) }));
  assert.equal(bad.reason, 'pull_request_unverified');
});

test('verifyMerge: failures return reasons and never throw', async () => {
  assert.equal((await verifyMerge(base({ gitCommand: fakeGit({ origin: 'https://github.com/o/other' }) }))).reason, 'repository_mismatch');
  assert.equal((await verifyMerge(base({ targetBranch: 'dev' }))).reason, 'target_not_default_branch');
  assert.equal((await verifyMerge(base({ gitCommand: fakeGit({ ancestor: false }) }))).reason, 'commit_not_reachable');
  const err = await verifyMerge(base({ gitCommand: fakeGit({ fail: 'boom' }) }));
  assert.deepEqual([err.verified, err.reason, err.error], [false, 'check_failed', 'boom']);
  assert.equal((await verifyMerge(base({ commit: 'zz' }))).reason, 'invalid_claim');
  assert.equal((await verifyMerge(base({ repositoryUrl: 5 }))).reason, 'check_failed');
});

test('recordCheck sets flags without bumping claim revision', async () => {
  const { store } = await tempStore();
  const s = await store.readSnapshot();
  const res = recordCheck(s, cap, { verified: false, reason: 'check_failed', error: 'boom', checkedAt: 't' }, NOW);
  assert.deepEqual(res, { ok: true });
  assert.equal(s.claims[0].revision, 2);
  assert.equal(s.claims[0].unverified, true);
  assert.deepEqual(s.claims[0].mergeCheck, { verified: false, reason: 'check_failed', error: 'boom', checkedAt: 't' });
  assert.deepEqual(recordCheck(s, { ...cap, revision: 1 }, {}, NOW), { ok: false, reason: 'stale_claim' });
});

test('applyMerge refuses stale, unverified and mismatched evidence', async () => {
  const { store } = await tempStore();
  const s = await store.readSnapshot();
  assert.equal(applyMerge(s, { ...cap, revision: 1 }, good, NOW).reason, 'stale_claim');
  assert.equal(applyMerge(s, cap, { verified: false }, NOW).reason, 'unverified');
  assert.equal(applyMerge(s, cap, { verified: true, commit: C2 }, NOW).reason, 'commit_mismatch');
  assert.equal(s.claims.length, 1);
  assert.equal(s.events.length, 0);
});

test('applyMerge writes archive, one event and outbox for linked lines only', async () => {
  const { store } = await tempStore();
  const s = await store.readSnapshot();
  const res = applyMerge(s, cap, good, NOW);
  assert.equal(res.ok, true);
  assert.equal(s.claims.length, 0);
  assert.equal(s.archive.length, 1);
  assert.equal(s.archive[0].status, 'merged');
  assert.equal(s.archive[0].mergeEvidence, good);
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].cursor, 1);
  assert.equal(s.eventCursor, 1);
  assert.deepEqual(s.outbox.map(o => o.recipientLineId).sort(), ['a', 'b']);
  assert.equal(s.outbox[0].noticeId, `${res.eventId}:${s.outbox[0].recipientLineId}`);
  assert.deepEqual(applyMerge(s, cap, good, NOW), { ok: true, duplicate: true, eventId: res.eventId });
  assert.equal(s.events.length, 1);
});

test('reconcile merges once; repeat and store reload add no duplicate', async () => {
  const { store, file } = await tempStore();
  const first = await reconcile(store, 'c1', base());
  assert.equal(first.merged, true);
  const again = await reconcile(store, 'c1', base());
  assert.deepEqual(again, { ok: true, merged: false, reason: 'already_merged' });
  const reloaded = await createStore(file).readSnapshot();
  assert.equal(reloaded.events.length, 1);
  assert.equal(reloaded.archive.length, 1);
  assert.equal(reloaded.outbox.length, 2);
  assert.equal(reloaded.events[0].id, first.eventId);
});

test('reconcile records unverified check and keeps claim', async () => {
  const { store } = await tempStore();
  const res = await reconcile(store, 'c1', base({ gitCommand: fakeGit({ ancestor: false }) }));
  assert.deepEqual(res, { ok: true, merged: false, reason: 'commit_not_reachable' });
  const s = await store.readSnapshot();
  assert.equal(s.claims[0].unverified, true);
  assert.equal(s.claims[0].revision, 2);
  assert.equal((await reconcile(store, 'nope', base())).reason, 'claim_not_found');
});

test('reconcile retries after a concurrent write and re-verifies the new commit', async () => {
  const { store } = await tempStore();
  let first = true;
  const commits = [];
  const gitCommand = async (p, args) => {
    const out = await fakeGit()(p, args);
    if (args[0] === 'merge-base') commits.push(args[2]);
    if (first && args[0] === 'fetch') {
      first = false;
      const s = await store.readSnapshot();
      await store.transact(s.revision, n => { Object.assign(n.claims[0], { revision: 3, commit: C2 }); });
    }
    return out;
  };
  const res = await reconcile(store, 'c1', base({ gitCommand }));
  assert.equal(res.merged, true);
  assert.deepEqual(commits, [C1, C2]);
  assert.equal((await store.readSnapshot()).archive[0].mergeEvidence.commit, C2);
});

test('reconcile gives stale_snapshot after maxAttempts', async () => {
  const { store } = await tempStore();
  const gitCommand = async (p, args) => {
    if (args[0] === 'fetch') { const s = await store.readSnapshot(); await store.transact(s.revision, () => {}); }
    return fakeGit()(p, args);
  };
  assert.deepEqual(await reconcile(store, 'c1', base({ gitCommand, maxAttempts: 2 })), { ok: false, reason: 'stale_snapshot' });
});

test('purgeExpired drops old archive and events, keeps outbox', () => {
  const old = new Date(NOW - RETENTION_MS - 1000).toISOString();
  const fresh = new Date(NOW).toISOString();
  const s = { archive: [{ mergedAt: old }, { mergedAt: fresh }], events: [{ at: old }, { at: fresh }], outbox: [{ noticeId: 'x' }] };
  assert.deepEqual(purgeExpired(s, NOW), { archive: 1, events: 1 });
  assert.equal(s.archive.length, 1);
  assert.equal(s.outbox.length, 1);
});

test('eventsAfter pages, caps limit and flags tooOld', () => {
  const events = Array.from({ length: 150 }, (_, i) => ({ id: `e${i + 6}`, cursor: i + 6 }));
  const s = { events, eventCursor: 155 };
  const page = eventsAfter(s, 5, 500);
  assert.equal(page.items.length, 100);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor, 105);
  assert.equal(page.tooOld, false);
  assert.equal(eventsAfter(s, 4).tooOld, true);
  const end = eventsAfter(s, 155);
  assert.deepEqual([end.items.length, end.hasMore, end.nextCursor], [0, false, 155]);
  assert.equal(eventsAfter({ events: [], eventCursor: 9 }, 3).tooOld, true);
});
