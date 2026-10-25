'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStore } = require('../work-registry');
const { createRefresh, matchRepo } = require('../registry-refresh');

const NOW = Date.parse('2026-01-10T00:00:00Z');
const C = n => String(n).padStart(40, 'a');
const URL1 = 'https://github.com/o/r.git';
const REPOS = [{ name: 'primary', path: '/p', url: 'git@github.com:o/r.git' }, { name: 'lib', path: '/lib', url: 'https://github.com/o/lib' }];
const claim = (n, over = {}) => ({ id: `c${n}`, revision: 1, commit: C(n), title: 'T', ownerLineId: 'own', repo: 'primary', branch: 'b', status: 'active', ...over });

function fakeGit({ reachable = true, calls = [], fail = false, gate } = {}) {
  return async (repoPath, args) => {
    calls.push([repoPath, ...args]);
    if (fail) throw new Error('boom');
    if (gate) await gate;
    if (args[0] === 'remote') return URL1;
    if (args[0] === 'ls-remote') return 'ref: refs/heads/main\tHEAD\n' + C(9) + '\tHEAD';
    if (args[0] === 'merge-base' && !(typeof reachable === 'function' ? reachable(args[2]) : reachable)) throw Object.assign(new Error('no'), { code: 1 });
    return '';
  };
}

async function setup(claims, opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refresh-'));
  const store = createStore(path.join(dir, 'reg.json'));
  await store.transact(0, s => { s.claims.push(...claims); });
  const deliver = [];
  const logs = [];
  const refresh = createRefresh({
    store, deliver: () => deliver.push(1), now: () => NOW, log: (e, d) => logs.push([e, d]),
    resolveRepo: c => matchRepo(c.ownerLineId === 'own' ? REPOS : [], c.repo), ...opts,
  });
  return { store, refresh, deliver, logs, snap: () => store.readSnapshot() };
}

function request(method, body) {
  const req = new EventEmitter();
  req.method = method;
  process.nextTick(() => { if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  return req;
}

test('matchRepo: name, url, primary, no match', () => {
  assert.deepEqual(matchRepo(REPOS, 'lib'), { repoPath: '/lib', repositoryUrl: 'https://github.com/o/lib.git' });
  assert.deepEqual(matchRepo(REPOS, 'https://github.com/o/lib.git'), { repoPath: '/lib', repositoryUrl: 'https://github.com/o/lib.git' });
  assert.deepEqual(matchRepo(REPOS, 'primary'), { repoPath: '/p', repositoryUrl: URL1 });
  assert.equal(matchRepo(REPOS, 'other'), null);
  assert.equal(matchRepo([{ name: 'x', path: '/x' }], 'x'), null);
});

test('unregistered repo is recorded as unverified', async () => {
  const t = await setup([claim(1, { repo: 'nope' })]);
  const r = await t.refresh.refreshClaim('c1');
  assert.equal(r.reason, 'repo-not-registered');
  assert.equal(r.repo, 'nope');
  const c = (await t.snap()).claims[0];
  assert.equal(c.mergeCheck.reason, 'repo-not-registered');
  assert.equal(c.unverified, true);
  assert.equal(t.deliver.length, 0);
});

test('forbidden body fields give 400', async () => {
  const t = await setup([claim(1)]);
  for (const field of ['repoPath', 'repositoryUrl', 'targetBranch', 'strategy']) {
    const out = await t.refresh.route(request('POST', { [field]: 'x' }), ['api', 'registry', 'claims', 'c1', 'refresh']);
    assert.equal(out.status, 400);
    assert.equal(out.body.code, 'FORBIDDEN_FIELD');
  }
  assert.equal((await t.refresh.route(request('POST', { strategy: 'merge' }), ['api', 'registry', 'refresh'])).status, 400);
  assert.equal(t.refresh.route(request('GET'), ['api', 'registry', 'refresh']), null);
});

test('merge path archives claim, one event, one delivery', async () => {
  const t = await setup([claim(1)], { gitCommand: fakeGit() });
  const out = await t.refresh.route(request('POST'), ['api', 'registry', 'claims', 'c1', 'refresh']);
  assert.equal(out.status, 200);
  assert.equal(out.body.result.merged, true);
  const s = await t.snap();
  assert.equal(s.claims.length, 0);
  assert.equal(s.archive[0].status, 'merged');
  assert.equal(s.archive[0].mergeEvidence.targetBranch, 'main');
  assert.equal(s.events.filter(e => e.type === 'claim.merged').length, 1);
  assert.equal(t.deliver.length, 1);
});

test('unknown claim gives 404', async () => {
  const t = await setup([]);
  assert.equal((await t.refresh.route(request('POST'), ['api', 'registry', 'claims', 'zz', 'refresh'])).status, 404);
});

test('squash path: matching PR merges, other PR stays unverified', async () => {
  const pr = commit => async arg => (arg.commit === commit ? { verified: true, merged: true, base: arg.targetBranch, repositoryUrl: arg.repositoryUrl, commit, number: 7 } : null);
  const git = fakeGit({ reachable: false });
  const t = await setup([claim(1)], { gitCommand: git, checkPullRequest: pr(C(1)) });
  const r = await t.refresh.refreshClaim('c1');
  assert.equal(r.merged, true);
  assert.equal((await t.snap()).archive[0].mergeEvidence.pullRequest, 7);
  const u = await setup([claim(1)], { gitCommand: git, checkPullRequest: pr(C(2)) });
  const r2 = await u.refresh.refreshClaim('c1');
  assert.equal(r2.merged, false);
  assert.equal(r2.reason, 'pull_request_unverified');
  assert.equal((await u.snap()).claims.length, 1);
  assert.equal(u.deliver.length, 0);
});

test('gh unavailable gives pr-check-unavailable', async () => {
  const bad = await setup([claim(1)], { gitCommand: fakeGit({ reachable: false }), checkPullRequest: async () => { throw new Error('gh missing'); } });
  assert.equal((await bad.refresh.refreshClaim('c1')).reason, 'pr-check-unavailable');
  assert.equal((await bad.snap()).claims[0].mergeCheck.reason, 'pr-check-unavailable');
  const none = await setup([claim(1)], { gitCommand: fakeGit({ reachable: false }) });
  assert.equal((await none.refresh.refreshClaim('c1')).reason, 'pr-check-unavailable');
});

test('sweep: max claims, status filter, recent check skip', async () => {
  const claims = [];
  for (let i = 1; i <= 25; i++) claims.push(claim(i));
  claims.push(claim(30, { status: 'paused' }), claim(31, { mergeCheck: { checkedAt: new Date(NOW - 10 * 60000).toISOString() } }),
    claim(32, { mergeCheck: { checkedAt: new Date(NOW - 31 * 60000).toISOString() } }));
  const calls = [];
  const t = await setup(claims, { gitCommand: fakeGit({ reachable: false, calls }), limits: { maxClaims: 20 } });
  const s = await t.refresh.sweep();
  assert.equal(s.checked, 20);
  assert.equal(s.unverified, 20);
  assert.equal(s.skipped, 1 + 6);
  assert.ok(!calls.some(c => c[0] === '/x'));
  const snap = await t.snap();
  assert.equal(snap.claims.find(c => c.id === 'c30').mergeCheck, undefined);
  assert.equal(snap.claims.find(c => c.id === 'c31').mergeCheck.reason, undefined);
});

test('sweep: merges deliver once, only one sweep runs at a time (202)', async () => {
  let open; const gate = new Promise(r => { open = r; });
  const t = await setup([claim(1), claim(2)], { gitCommand: fakeGit({ gate }) });
  const first = t.refresh.sweep();
  const second = await t.refresh.route(request('POST'), ['api', 'registry', 'refresh']);
  assert.deepEqual([second.status, second.body], [202, { started: true }]);
  open();
  const s = await first;
  assert.equal(s.merged, 2);
  assert.equal(t.deliver.length, 1);
  const again = await t.refresh.route(request('POST'), ['api', 'registry', 'refresh']);
  assert.equal(again.status, 200);
});

test('sweep purges expired archive and events at the end', async () => {
  const old = new Date(NOW - 40 * 86400000).toISOString();
  const t = await setup([]);
  await t.store.transact(null, s => {
    s.archive.push({ id: 'old', status: 'merged', mergedAt: old });
    s.events.push({ id: 'e', cursor: 1, type: 'claim.merged', at: old });
    s.eventCursor = 1;
  });
  const s = await t.refresh.sweep();
  assert.equal(s.purged, 2);
  assert.equal((await t.snap()).archive.length, 0);
});

test('throwing git never throws out of refreshClaim or sweep', async () => {
  const t = await setup([claim(1), claim(2)], { gitCommand: fakeGit({ fail: true }) });
  const r = await t.refresh.refreshClaim('c1');
  assert.equal(r.merged, false);
  assert.equal(r.reason, 'default_branch_unknown');
  assert.equal((await t.snap()).claims[0].mergeCheck.reason, 'default_branch_unknown');
  const s = await t.refresh.sweep();
  assert.equal(s.checked, 1);
  assert.equal(s.skipped, 1);
  const broken = await setup([claim(1)], { gitCommand: () => { throw new Error('sync'); }, deliver: () => { throw new Error('d'); } });
  assert.equal((await broken.refresh.sweep()).checked, 1);
});
