'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createStore, rememberIdempotent, lookupIdempotent, IDEMPOTENCY_MAX } = require('../work-registry');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-registry-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'lines', 'work-coordination.json');
}

test('persists snapshots and reloads them after restart', async t => {
  const file = await fixture(t);
  const store = createStore(file);
  const created = await store.createClaim(0, { title: 'Shared task', tags: ['router'] });
  assert.equal(created.revision, 1);
  const restarted = createStore(file);
  assert.equal((await restarted.readSnapshot()).claims[0].title, 'Shared task');
});

test('serializes updates from separate line stores and rejects stale revisions', async t => {
  const file = await fixture(t);
  const a = createStore(file), b = createStore(file);
  const results = await Promise.all([
    a.createClaim(0, { title: 'A' }), b.createClaim(0, { title: 'B' }),
  ]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.find(result => !result.ok).revision, 1);
  const snapshot = await a.readSnapshot();
  assert.equal(snapshot.claims.length, 1);
});

test('search returns pages across retained matches', async t => {
  const store = createStore(await fixture(t));
  await store.createClaim(0, { title: 'Alpha one', summary: 'shared', tags: ['x'] });
  await store.createClaim(1, { title: 'Alpha two', tags: ['y'] });
  await store.createClaim(2, { title: 'Other' });
  assert.deepEqual((await store.searchClaims('alpha', { page: 2, pageSize: 1 })).items.map(item => item.title), ['Alpha two']);
  assert.equal((await store.searchClaims('alpha')).total, 2);
});

test('write failure before rename keeps the old snapshot', async t => {
  const file = await fixture(t);
  const store = createStore(file);
  await store.createClaim(0, { title: 'Kept' });
  await fs.chmod(path.dirname(file), 0o500);
  t.after(() => fs.chmod(path.dirname(file), 0o700));
  await assert.rejects(store.createClaim(1, { title: 'Lost' }), /Cannot write work registry/);
  await fs.chmod(path.dirname(file), 0o700);
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.revision, 1);
  assert.deepEqual(snapshot.claims.map(c => c.title), ['Kept']);
  assert.deepEqual((await fs.readdir(path.dirname(file))), ['work-coordination.json']);
});

test('stale snapshot revision returns stale result', async t => {
  const store = createStore(await fixture(t));
  await store.transact(0, () => 1);
  assert.deepEqual(await store.transact(0, () => 2), { ok: false, stale: true, revision: 1 });
  assert.deepEqual(await store.transact(1, () => 'x'), { ok: true, revision: 2, result: 'x' });
});

test('concurrent transactions from two stores all apply in order', async t => {
  const file = await fixture(t);
  const a = createStore(file), b = createStore(file);
  const [r1, r2] = await Promise.all([a.transact(0, s => s.events.push({ id: 'e1' })), b.transact(0, s => s.events.push({ id: 'e2' }))]);
  assert.equal([r1, r2].filter(r => r.ok).length, 1);
  const retry = [r1, r2].some(r => !r.ok) ? await b.transact((await b.readSnapshot()).revision, s => s.events.push({ id: 'e3' })) : null;
  assert.equal(retry.ok, true);
  assert.equal((await a.readSnapshot()).events.length, 2);
});

test('missing file loads an empty version 1 snapshot', async t => {
  const snapshot = await createStore(await fixture(t)).load();
  assert.deepEqual(Object.keys(snapshot).sort(), ['archive', 'claims', 'eventCursor', 'events', 'idempotency', 'outbox', 'requests', 'revision', 'tombstones', 'version']);
  assert.equal(snapshot.version, 1);
});

test('corrupt file throws REGISTRY_CORRUPT and stays untouched', async t => {
  const file = await fixture(t);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{broken');
  const store = createStore(file);
  await assert.rejects(store.load(), e => e.code === 'REGISTRY_CORRUPT' && e.filePath === file && e.message.includes(file));
  await assert.rejects(store.readSnapshot(), { code: 'REGISTRY_CORRUPT' });
  await assert.rejects(store.createClaim(0, { title: 'x' }), { code: 'REGISTRY_CORRUPT' });
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});

test('item validation rejects bad snapshots', async t => {
  const file = await fixture(t);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const base = { version: 1, revision: 1, claims: [], requests: [], archive: [], events: [], outbox: [], eventCursor: 0, tombstones: [], idempotency: [] };
  const bad = [
    { claims: [null] }, { outbox: [3] }, { events: [{}] }, { archive: [{ id: 5 }] },
    { claims: [{ id: 'a', revision: 0 }] }, { requests: [{ id: 'a' }] }, { requests: [{ id: 'a', revision: 1.5 }] },
    { eventCursor: -1 }, { revision: -1 }, { tombstones: {} }, { version: 2 },
  ];
  for (const patch of bad) {
    await fs.writeFile(file, JSON.stringify({ ...base, ...patch }));
    await assert.rejects(createStore(file).load(), { code: 'REGISTRY_CORRUPT' }, JSON.stringify(patch));
  }
  await fs.writeFile(file, JSON.stringify({ ...base, claims: [{ id: 'a', revision: 1 }] }));
  assert.equal((await createStore(file).load()).claims.length, 1);
});

test('invalid IDs are rejected and generated IDs match', async t => {
  const store = createStore(await fixture(t));
  for (const id of ['a/../b', '', 'x'.repeat(65), 'a b', 5]) {
    await assert.rejects(store.createClaim(0, { title: 'T', id }), { code: 'INVALID_ID' });
  }
  await assert.rejects(store.updateClaim(0, 'a/../b', 1, { title: 'T' }), { code: 'INVALID_ID' });
  const made = await store.createClaim(0, { title: 'T' });
  assert.match(made.result.id, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal((await store.createClaim(1, { title: 'T', id: 'ok_1-a' })).result.id, 'ok_1-a');
});

test('idempotency hit, miss, conflict and bound', async t => {
  const store = createStore(await fixture(t));
  const snap = { idempotency: [] };
  assert.deepEqual(lookupIdempotent(snap, 's', 'k', 'f1'), { hit: false });
  rememberIdempotent(snap, 's', 'k', 'f1', { id: 'r1' });
  assert.deepEqual(lookupIdempotent(snap, 's', 'k', 'f1'), { hit: true, result: { id: 'r1' } });
  assert.deepEqual(lookupIdempotent(snap, 's', 'k', 'f2'), { conflict: true });
  assert.deepEqual(lookupIdempotent(snap, 'other', 'k', 'f2'), { hit: false });
  for (let i = 0; i < IDEMPOTENCY_MAX + 5; i++) rememberIdempotent(snap, 's', `n${i}`, 'f', i);
  assert.equal(snap.idempotency.length, IDEMPOTENCY_MAX);
  assert.deepEqual(lookupIdempotent(snap, 's', 'k', 'f1'), { hit: false });
  assert.deepEqual(lookupIdempotent(snap, 's', `n${IDEMPOTENCY_MAX + 4}`, 'f'), { hit: true, result: IDEMPOTENCY_MAX + 4 });
  assert.throws(() => rememberIdempotent(snap, '', 'k', 'f', 1), TypeError);
  await store.transact(0, s => rememberIdempotent(s, 's', 'k', 'f', { ok: 1 }));
  assert.deepEqual(lookupIdempotent(await store.readSnapshot(), 's', 'k', 'f'), { hit: true, result: { ok: 1 } });
});

test('stale claim revision returns a conflict and missing claim throws NOT_FOUND', async t => {
  const store = createStore(await fixture(t));
  const { result } = await store.createClaim(0, { title: 'T' });
  assert.deepEqual(await store.updateClaim(1, result.id, 99, { title: 'U' }), { ok: false, conflict: true, currentRevision: 1 });
  assert.equal((await store.readSnapshot()).revision, 1);
  const updated = await store.updateClaim(1, result.id, 1, { title: 'U' });
  assert.equal(updated.result.revision, 2);
  await assert.rejects(store.updateClaim(2, 'missing', 1, { title: 'U' }), { code: 'NOT_FOUND', status: 404 });
});
