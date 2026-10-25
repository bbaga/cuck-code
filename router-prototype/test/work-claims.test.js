'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../work-claims');

const SHA = 'a'.repeat(40);
const NOW = 1_000_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const base = { title: 'T', repo: 'r', branch: 'feat/x', commit: SHA };
const mk = (over = {}) => ({ id: 'c1', ...base, summary: '', tags: [], contract: '', status: 'active', ownerLineId: 'L1', createdAt: NOW, updatedAt: NOW, confirmedAt: NOW, ...over });
const code = r => `${r.ok}:${r.status}:${r.code}`;

test('constants', () => {
  assert.equal(C.STALE_AGE_MS, 14 * DAY);
  assert.equal(C.BRANCH_GRACE_MS, DAY);
  assert.equal(C.TOMBSTONE_RETENTION_MS, 30 * DAY);
  assert.deepEqual(C.CURRENT_STATUSES, ['planned', 'active', 'available']);
});

test('validateNewClaim builds a claim with defaults and normalized tags', () => {
  const r = C.validateNewClaim({ ...base, tags: ['A', 'a', 'b'] }, 'L1', NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.claim.tags, ['a', 'b']);
  assert.equal(r.claim.status, 'planned');
  assert.equal(r.claim.ownerLineId, 'L1');
  assert.equal(r.claim.confirmedAt, NOW);
  assert.equal('id' in r.claim, false);
  assert.equal('revision' in r.claim, false);
});

test('validateNewClaim rejects bad input', () => {
  const v = input => C.validateNewClaim(input, 'L1', NOW);
  assert.equal(code(v({ ...base, extra: 1 })), 'false:400:UNKNOWN_FIELD');
  for (const k of ['ownerLineId', 'id', 'revision']) assert.equal(v({ ...base, [k]: 'x' }).status, 400);
  assert.equal(code(v({ ...base, status: 'merged' })), 'false:403:FORBIDDEN_STATUS');
  assert.equal(code(v({ ...base, status: 'stale' })), 'false:403:FORBIDDEN_STATUS');
  assert.equal(v({ ...base, status: 'superseded' }).status, 400);
  assert.equal(v({ ...base, status: 'bogus' }).status, 400);
  assert.equal(v({ ...base, title: '' }).code, 'INVALID_FIELD');
  assert.equal(v({ ...base, title: 'x'.repeat(201) }).ok, false);
  assert.equal(v({ ...base, summary: 'x'.repeat(2001) }).ok, false);
  assert.equal(v({ ...base, contract: 'x'.repeat(4001) }).ok, false);
  assert.equal(v({ ...base, branch: 'a b' }).ok, false);
  assert.equal(v({ ...base, branch: 'a..b' }).ok, false);
  assert.equal(v({ ...base, commit: 'A'.repeat(40) }).ok, false);
  assert.equal(v({ ...base, commit: 'abc' }).ok, false);
  assert.equal(v({ ...base, tags: Array(21).fill('t') }).ok, false);
  assert.equal(v({ ...base, tags: [''] }).ok, false);
  assert.equal(v({ ...base, tags: ['x'.repeat(41)] }).ok, false);
  assert.equal(v({ title: 'T' }).code, 'MISSING_FIELD');
  assert.equal(v(null).code, 'INVALID_BODY');
  assert.equal(v({ ...base, status: 'available' }).ok, true);
});

test('applyOwnerPatch rules', () => {
  const c = mk();
  const frozen = JSON.stringify(c);
  const r = C.applyOwnerPatch(c, { title: 'New', status: 'available' }, 'L1', NOW + 5);
  assert.equal(r.ok, true);
  assert.equal(r.claim.title, 'New');
  assert.equal(r.claim.status, 'available');
  assert.equal(r.claim.updatedAt, NOW + 5);
  assert.notEqual(r.claim, c);
  assert.equal(JSON.stringify(c), frozen);
  assert.equal(code(C.applyOwnerPatch(c, { title: 'x' }, 'L2', NOW)), 'false:403:NOT_OWNER');
  assert.equal(code(C.applyOwnerPatch(c, { status: 'stale' }, 'L1', NOW)), 'false:403:FORBIDDEN_STATUS');
  assert.equal(code(C.applyOwnerPatch(c, { status: 'merged' }, 'L1', NOW)), 'false:403:FORBIDDEN_STATUS');
  assert.equal(code(C.applyOwnerPatch(c, { repo: 'x' }, 'L1', NOW)), 'false:400:UNKNOWN_FIELD');
  assert.equal(C.applyOwnerPatch(c, { status: 'superseded' }, 'L1', NOW).claim.status, 'superseded');
  for (const status of ['superseded', 'merged']) {
    assert.equal(code(C.applyOwnerPatch(mk({ status }), { title: 'x' }, 'L1', NOW)), 'false:409:TERMINAL');
  }
});

test('applyOwnerPatch on stale claims', () => {
  const s = mk({ status: 'stale' });
  assert.equal(code(C.applyOwnerPatch(s, { title: 'x' }, 'L1', NOW)), 'false:409:STALE_CLAIM');
  assert.equal(code(C.applyOwnerPatch(s, { status: 'active' }, 'L1', NOW)), 'false:409:STALE_CLAIM');
  assert.equal(C.applyOwnerPatch(s, { status: 'superseded' }, 'L1', NOW).claim.status, 'superseded');
});

test('branch or commit change clears branch-check state', () => {
  const c = mk({ branchConfirmedAt: NOW, branchCheckedAt: NOW });
  const same = C.applyOwnerPatch(c, { branch: c.branch }, 'L1', NOW + 1).claim;
  assert.equal(same.branchConfirmedAt, NOW);
  for (const patch of [{ branch: 'other' }, { commit: 'b'.repeat(40) }]) {
    const r = C.applyOwnerPatch(c, patch, 'L1', NOW + 9).claim;
    assert.equal('branchConfirmedAt' in r, false);
    assert.equal(r.branchChangedAt, NOW + 9);
  }
  assert.equal(C.applyOwnerPatch(c, { branch: 'a b' }, 'L1', NOW).ok, false);
});

test('renewClaim', () => {
  const s = mk({ status: 'stale', staleReason: 'age', staleAt: NOW });
  const r = C.renewClaim(s, 'L1', NOW + 9, {});
  assert.equal(r.claim.status, 'active');
  assert.equal(r.claim.confirmedAt, NOW + 9);
  assert.equal('staleReason' in r.claim, false);
  assert.equal(C.renewClaim(s, 'L1', NOW, { status: 'available' }).claim.status, 'available');
  assert.equal(C.renewClaim(mk({ status: 'planned' }), 'L1', NOW + 1).claim.status, 'planned');
  assert.equal(s.status, 'stale');
  assert.equal(code(C.renewClaim(s, 'L1', NOW, { status: 'merged' })), 'false:400:INVALID_STATUS');
  assert.equal(code(C.renewClaim(s, 'L1', NOW, { status: 'superseded' })), 'false:400:INVALID_STATUS');
  assert.equal(code(C.renewClaim(s, 'L2', NOW, {})), 'false:403:NOT_OWNER');
  assert.equal(code(C.renewClaim(mk({ status: 'superseded' }), 'L1', NOW, {})), 'false:409:TERMINAL');
  assert.equal(code(C.renewClaim(mk({ status: 'merged' }), 'L1', NOW, {})), 'false:409:TERMINAL');
});

test('supersedeClaim', () => {
  const c = mk();
  const r = C.supersedeClaim(c, 'L1', NOW + 1, { byClaimId: 'c2' });
  assert.equal(r.claim.status, 'superseded');
  assert.equal(r.claim.supersededBy, 'c2');
  assert.equal(c.status, 'active');
  assert.equal(C.supersedeClaim(mk({ status: 'stale' }), 'L1', NOW, {}).claim.status, 'superseded');
  assert.equal(code(C.supersedeClaim(c, 'L1', NOW, { byClaimId: 'bad id' })), 'false:400:INVALID_ID');
  assert.equal(code(C.supersedeClaim(c, 'L2', NOW, {})), 'false:403:NOT_OWNER');
  assert.equal(code(C.supersedeClaim(mk({ status: 'merged' }), 'L1', NOW, {})), 'false:409:TERMINAL');
});

test('evaluateStaleness', () => {
  const c = mk();
  const ev = (o, claim = c) => C.evaluateStaleness(claim, { now: NOW, ...o });
  assert.deepEqual(ev({ ownerExists: true }), { stale: false });
  assert.deepEqual(ev({ ownerExists: false }), { stale: true, reason: 'owner-gone' });
  // age boundary
  assert.equal(C.evaluateStaleness(c, { now: NOW + 14 * DAY, ownerExists: true }).stale, false);
  assert.deepEqual(C.evaluateStaleness(c, { now: NOW + 14 * DAY + 1, ownerExists: true }), { stale: true, reason: 'age' });
  // branch grace boundary
  const miss = now => C.evaluateStaleness(c, { now, ownerExists: true, branchCheckedAt: now });
  assert.equal(miss(NOW + DAY).stale, false);
  assert.equal(miss(NOW + DAY + 1).reason, 'branch-missing');
  assert.equal(C.evaluateStaleness(c, { now: NOW + DAY + 1, ownerExists: true, branchCheckedAt: NOW, branchConfirmedAt: NOW }).stale, false);
  assert.equal(C.evaluateStaleness(c, { now: NOW + DAY + 1, ownerExists: true }).stale, false);
  // grace restarts after a branch change
  const changed = mk({ branchChangedAt: NOW + 10 * DAY });
  assert.equal(C.evaluateStaleness(changed, { now: NOW + 10 * DAY + DAY, ownerExists: true, branchCheckedAt: 1 }).stale, false);
  // order
  assert.equal(C.evaluateStaleness(c, { now: NOW + 20 * DAY, ownerExists: false, branchCheckedAt: 1 }).reason, 'owner-gone');
  assert.equal(C.evaluateStaleness(c, { now: NOW + 20 * DAY, ownerExists: true, branchCheckedAt: 1 }).reason, 'branch-missing');
  for (const status of ['stale', 'superseded', 'merged']) {
    assert.deepEqual(C.evaluateStaleness(mk({ status }), { now: NOW + 99 * DAY, ownerExists: false }), { stale: false });
  }
});

test('markStale returns a new stale claim and an event', () => {
  const c = mk();
  const r = C.markStale(c, 'age', NOW + 3);
  assert.equal(r.claim.status, 'stale');
  assert.equal(r.claim.staleReason, 'age');
  assert.equal(r.claim.staleAt, NOW + 3);
  assert.equal(c.status, 'active');
  assert.deepEqual(r.event, { type: 'claim.stale', claimId: 'c1', ownerLineId: 'L1', reason: 'age', at: NOW + 3 });
});

test('retireClaim and purgeTombstones', () => {
  const r = C.retireClaim(mk({ title: 'Hello' }), 'deleted', NOW);
  assert.deepEqual(r.tombstone, { claimId: 'c1', ownerLineId: 'L1', title: 'Hello', status: 'active', reason: 'deleted', retiredAt: NOW });
  assert.deepEqual(r.event, { type: 'claim.retired', claimId: 'c1', ownerLineId: 'L1', reason: 'deleted', at: NOW });
  assert.equal(code(C.retireClaim(mk({ status: 'merged' }), 'expired', NOW)), 'false:409:MERGED_CLAIM');
  const list = [{ claimId: 'a', retiredAt: NOW }, { claimId: 'b', retiredAt: NOW - 1 }];
  const out = C.purgeTombstones(list, NOW + 30 * DAY);
  assert.deepEqual(out.map(t => t.claimId), ['a']);
  assert.notEqual(out, list);
  assert.equal(list.length, 2);
});

test('onLineDeleted', () => {
  const claims = [
    mk({ id: 'a', status: 'planned' }), mk({ id: 'b', status: 'available' }),
    mk({ id: 'c', status: 'merged' }), mk({ id: 'd', status: 'superseded' }),
    mk({ id: 'e', status: 'stale' }), mk({ id: 'f', ownerLineId: 'L2' })
  ];
  const requests = [
    { id: 'r1', state: 'open', sourceLineId: 'L1', targetLineId: 'L2' },
    { id: 'r2', state: 'accepted', sourceLineId: 'L2', targetLineId: 'L1' },
    { id: 'r3', state: 'closed', sourceLineId: 'L1', targetLineId: 'L2' },
    { id: 'r4', state: 'open', sourceLineId: 'L2', targetLineId: 'L3' }
  ];
  const r = C.onLineDeleted({ claims, requests }, 'L1', NOW + 7);
  assert.deepEqual(r.claimUpdates.map(c => c.id), ['a', 'b']);
  assert.ok(r.claimUpdates.every(c => c.status === 'stale' && c.staleReason === 'owner-gone'));
  assert.deepEqual(r.requestUpdates.map(q => q.id), ['r1', 'r2']);
  assert.ok(r.requestUpdates.every(q => q.orphaned && q.orphanedAt === NOW + 7 && q.state !== 'closed'));
  assert.equal(r.requestUpdates[0].state, 'open');
  assert.equal(requests[0].orphaned, undefined);
  assert.deepEqual(r.events.filter(e => e.type === 'request.orphaned'), [
    { type: 'request.orphaned', requestId: 'r1', lineId: 'L1', at: NOW + 7 },
    { type: 'request.orphaned', requestId: 'r2', lineId: 'L1', at: NOW + 7 }
  ]);
  assert.equal(r.events.filter(e => e.type === 'claim.stale').length, 2);
});

test('no function produces status merged', () => {
  const results = [];
  for (const status of C.STATUSES) {
    const c = mk({ status });
    for (const patchStatus of C.STATUSES) results.push(C.applyOwnerPatch(c, { status: patchStatus }, 'L1', NOW));
    results.push(C.applyOwnerPatch(c, { title: 'x' }, 'L1', NOW), C.renewClaim(c, 'L1', NOW, {}), C.supersedeClaim(c, 'L1', NOW, {}),
      C.evaluateStaleness(c, { now: NOW + 99 * DAY, ownerExists: false }), C.markStale(c, 'age', NOW), C.retireClaim(c, 'expired', NOW),
      C.onLineDeleted({ claims: [c], requests: [] }, 'L1', NOW), C.validateNewClaim({ ...base, status }, 'L1', NOW));
  }
  const walk = v => {
    if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => {
      if (k === 'status' && x === 'merged') throw new Error('merged produced');
      walk(x);
    });
  };
  // Only inputs that already were merged may carry merged; those must fail instead.
  for (const r of results) {
    if (r && r.ok === false) continue;
    walk(r);
  }
});
