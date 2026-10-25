'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../work-registry');

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

test('rejects invalid snapshot data without replacing it', async t => {
  const file = await fixture(t);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{broken');
  await assert.rejects(createStore(file).readSnapshot(), /Cannot load work registry/);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});

test('search returns pages across retained matches', async t => {
  const store = createStore(await fixture(t));
  await store.createClaim(0, { title: 'Alpha one', summary: 'shared', tags: ['x'] });
  await store.createClaim(1, { title: 'Alpha two', tags: ['y'] });
  await store.createClaim(2, { title: 'Other' });
  assert.deepEqual((await store.searchClaims('alpha', { page: 2, pageSize: 1 })).items.map(item => item.title), ['Alpha two']);
  assert.equal((await store.searchClaims('alpha')).total, 2);
});

test('write failure leaves memory revision unchanged', async t => {
  const file = await fixture(t);
  const store = createStore(file);
  await store.readSnapshot();
  await fs.writeFile(path.dirname(file), 'block parent directory');
  await assert.rejects(store.createClaim(0, { title: 'Failure' }), /Cannot load work registry/);
  assert.equal((await store.readSnapshot()).revision, 0);
});
