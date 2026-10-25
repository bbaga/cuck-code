'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../work-registry');
const { createStalenessSweep } = require('../registry-staleness');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-03-01T00:00:00Z');
const claim = (n, over = {}) => ({
  id: `c${n}`, revision: 1, title: 'T', ownerLineId: 'own', repo: 'primary', branch: `b${n}`, status: 'active',
  createdAt: NOW - 2 * DAY, updatedAt: NOW - 2 * DAY + n, confirmedAt: NOW - DAY, ...over,
});
const present = branch => `${'a'.repeat(40)}\trefs/heads/${branch}\n`;

async function setup(claims, opts = {}, seed = () => {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stale-'));
  const store = createStore(path.join(dir, 'reg.json'));
  await store.transact(0, s => { s.claims.push(...claims); seed(s); });
  const calls = [];
  const logs = [];
  const sweeper = createStalenessSweep({
    store, now: () => NOW, log: (e, d) => logs.push([e, d]),
    getLine: id => (id === 'own' ? { id } : id === 'dead' ? { id, deleted: true } : undefined),
    resolveRepo: () => ({ repoPath: '/p' }),
    gitCommand: async (p, args) => { calls.push(args); return present(args[3].replace('refs/heads/', '')); },
    ...opts,
  });
  const find = async id => (await store.readSnapshot()).claims.find(c => c.id === id);
  return { store, sweeper, calls, logs, find, snap: () => store.readSnapshot() };
}

test('owner line gone or deleted -> stale owner-gone with event', async () => {
  const t = await setup([claim(1, { ownerLineId: 'dead' }), claim(2, { ownerLineId: 'nobody' })]);
  const s = await t.sweeper.sweep();
  assert.equal(s.markedStale, 2);
  const c = await t.find('c1');
  assert.equal(c.status, 'stale');
  assert.equal(c.staleReason, 'owner-gone');
  assert.equal(c.revision, 2);
  assert.equal((await t.snap()).events.filter(e => e.type === 'claim.stale' && e.reason === 'owner-gone').length, 2);
});

test('branch missing after grace -> stale; within grace -> not stale', async () => {
  const git = async () => '';
  const t = await setup([claim(1), claim(2, { createdAt: NOW - HOUR })], { gitCommand: git });
  await t.sweeper.sweep();
  assert.equal((await t.find('c1')).staleReason, 'branch-missing');
  assert.equal((await t.find('c2')).status, 'active');
});

test('git error, timeout or unresolvable repo is not branch-missing', async () => {
  for (const opts of [{ gitCommand: async () => { throw new Error('x'); } }, { resolveRepo: () => null },
    { gitCommand: () => new Promise(() => {}), limits: { gitTimeoutMs: 10 } }]) {
    const t = await setup([claim(1)], opts);
    const s = await t.sweeper.sweep();
    assert.equal(s.markedStale, 0);
    assert.equal((await t.find('c1')).status, 'active');
  }
});

test('age: more than 14 days stale, exactly 14 days not', async () => {
  const t = await setup([claim(1, { confirmedAt: NOW - 14 * DAY - 1 }), claim(2, { confirmedAt: NOW - 14 * DAY })]);
  await t.sweeper.sweep();
  assert.equal((await t.find('c1')).staleReason, 'age');
  assert.equal((await t.find('c2')).status, 'active');
});

test('branch check skipped when checked less than 6 hours ago; bounds hold', async () => {
  const t = await setup([claim(1, { branchCheckedAt: NOW - 5 * HOUR, branchConfirmedAt: NOW - 5 * HOUR }), claim(2), claim(3), claim(4)],
    { limits: { maxBranchChecks: 2, maxClaims: 3 } });
  const s = await t.sweeper.sweep();
  assert.equal(s.checked, 3);
  assert.equal(s.branchChecked, 2);
  assert.equal(t.calls.length, 2);
  assert.equal((await t.find('c4')).branchCheckedAt, undefined);
});

test('background branch fields keep the revision', async () => {
  const t = await setup([claim(1)]);
  await t.sweeper.sweep();
  const c = await t.find('c1');
  assert.equal(c.branchConfirmedAt, NOW);
  assert.equal(c.branchCheckedAt, NOW);
  assert.equal(c.revision, 1);
});

test('claim changed by owner between evaluation and mutation is skipped', async () => {
  let store;
  const t = await setup([claim(1, { ownerLineId: 'dead' })]);
  store = t.store;
  const sweeper = createStalenessSweep({
    store, now: () => NOW, log: () => {}, resolveRepo: () => null,
    getLine: () => { // runs before the mutation
      store.transact(null, s => { s.claims[0].revision = 2; });
      return undefined;
    },
  });
  await new Promise(r => setTimeout(r, 0));
  const s = await sweeper.sweep();
  assert.equal(s.markedStale, 0);
  assert.equal((await t.find('c1')).status, 'active');
});

test('stale claim older than 30 days is retired; merged and archive are untouched', async () => {
  const old = { status: 'stale', staleReason: 'age', staleAt: NOW - 30 * DAY - 1 };
  const t = await setup([claim(1, old), claim(2, { ...old, staleAt: NOW - 30 * DAY }), claim(3, { status: 'merged', staleAt: NOW - 90 * DAY })],
    {}, s => { s.archive.push({ id: 'arch', claimId: 'x' }); });
  const s = await t.sweeper.sweep();
  assert.equal(s.retired, 1);
  const snap = await t.snap();
  assert.deepEqual(snap.claims.map(c => c.id).sort(), ['c2', 'c3']);
  assert.equal(snap.tombstones[0].claimId, 'c1');
  assert.equal(snap.events.filter(e => e.type === 'claim.retired').length, 1);
  assert.equal(snap.archive.length, 1);
});

test('tombstones older than 30 days are purged', async () => {
  const t = await setup([], {}, s => {
    s.tombstones.push({ claimId: 'a', ownerLineId: 'o', title: 't', status: 'stale', reason: 'expired', retiredAt: NOW - 31 * DAY },
      { claimId: 'b', ownerLineId: 'o', title: 't', status: 'stale', reason: 'expired', retiredAt: NOW - DAY });
  });
  const s = await t.sweeper.sweep();
  assert.equal(s.purgedTombstones, 1);
  assert.deepEqual((await t.snap()).tombstones.map(x => x.claimId), ['b']);
});

test('no claim.merged event is produced', async () => {
  const t = await setup([claim(1, { confirmedAt: NOW - 20 * DAY }), claim(2, { ownerLineId: 'dead' }),
    claim(3, { status: 'stale', staleAt: NOW - 40 * DAY })]);
  await t.sweeper.sweep();
  const types = (await t.snap()).events.map(e => e.type);
  assert.ok(types.length >= 3);
  assert.ok(!types.includes('claim.merged'));
});

test('second concurrent sweep returns null; throwing git never throws', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const t = await setup([claim(1)], { gitCommand: async () => { await gate; throw new Error('boom'); } });
  const first = t.sweeper.sweep();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(await t.sweeper.sweep(), null);
  release();
  const s = await first;
  assert.equal(s.markedStale, 0);
  assert.ok(t.logs.some(([e, d]) => e === 'registry.staleness.branch_check_failed' && d.claimId === 'c1'));
});

test('route: 200 with summary, 202 while running, null for other routes', async () => {
  const t = await setup([]);
  const req = { method: 'POST', resume() {} };
  assert.equal(t.sweeper.route({ method: 'GET', resume() {} }, ['api', 'registry', 'staleness', 'sweep']), null);
  const out = await t.sweeper.route(req, ['api', 'registry', 'staleness', 'sweep']);
  assert.equal(out.status, 200);
  assert.equal(out.body.summary.checked, 0);
});

test('empty sweep keeps the snapshot revision; a purge raises it by 1', async () => {
  const t = await setup([]);
  const before = (await t.snap()).revision;
  await t.sweeper.sweep();
  assert.equal((await t.snap()).revision, before);
  await t.store.transact(null, s => { s.tombstones.push({ claimId: 'a', ownerLineId: 'o', title: 't', status: 'stale', reason: 'expired', retiredAt: NOW - 31 * DAY }); });
  await t.sweeper.sweep();
  assert.equal((await t.snap()).revision, before + 2);
});

test('route returns 202 while a sweep runs', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const t = await setup([claim(1)], { gitCommand: async () => { await gate; return ''; } });
  const first = t.sweeper.sweep();
  await new Promise(r => setTimeout(r, 20));
  const out = await t.sweeper.route({ method: 'POST', resume() {} }, ['api', 'registry', 'staleness', 'sweep']);
  assert.equal(out.status, 202);
  release();
  await first;
});
