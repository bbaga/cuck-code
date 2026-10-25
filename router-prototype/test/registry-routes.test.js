'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../work-registry');
const { createRegistryRoutes } = require('../registry-routes');

const claim = (id, o = {}) => ({ id, revision: 1, ownerLineId: 'L1', repo: 'r1', branch: 'b', title: `Title ${id}`, summary: '', tags: [], status: 'active', key: 'secretkey', ...o });
const SNAP = {
  version: 1, revision: 7, eventCursor: 5, tombstones: [], idempotency: [], outbox: [],
  claims: [claim('c1', { tags: ['Alpha'] }), claim('c2', { status: 'merged', repo: 'r2' }), claim('c3', { ownerLineId: 'L2', status: 'planned', contract: 'API-X', evidence: 'hiddenev' }), claim('c4', { status: 'stale' })],
  archive: [claim('a1', { status: 'merged', title: 'Old thing' })],
  requests: [
    { id: 'q1', revision: 1, sourceLineId: 'L1', targetLineId: 'L2', state: 'open', subject: 'Need Help', text: 'please', secret: 'zzz' },
    { id: 'q2', revision: 1, sourceLineId: 'L3', targetLineId: 'L4', state: 'closed', subject: 's', text: 't' },
  ],
  events: [3, 4, 5].map(c => ({ id: `e${c}`, cursor: c, type: 'x' })),
};

async function setup(snap = SNAP, raw) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-'));
  const file = path.join(dir, 'reg.json');
  await fs.writeFile(file, raw ?? JSON.stringify(snap));
  const store = createStore(file);
  const routes = createRegistryRoutes({ store, lineExists: id => id === 'L1', lineName: id => (id === 'L1' ? 'Line One' : null) });
  return { routes, store, file };
}

function call(routes, pathAndQuery, method = 'GET') {
  const url = new URL(pathAndQuery, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  return new Promise(resolve => {
    const handled = routes.handle({ method }, {}, url, parts, (res, code, body) => resolve({ code, body, handled: true }));
    if (!handled) resolve({ handled });
  });
}

test('claims default to current statuses and add owner fields', async () => {
  const { routes } = await setup();
  const r = await call(routes, '/api/registry/claims');
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.items.map(c => c.id), ['c1', 'c3']);
  assert.equal(r.body.items[0].ownerLineName, 'Line One');
  assert.equal(r.body.items[0].ownerExists, true);
  assert.equal(r.body.items[1].ownerLineName, null);
  assert.equal(r.body.items[1].ownerExists, false);
  assert.equal(r.body.snapshotRevision, 7);
  assert.equal(r.body.total, 2);
});

test('claims status all, comma list, unknown value', async () => {
  const { routes } = await setup();
  assert.equal((await call(routes, '/api/registry/claims?status=all')).body.total, 4);
  assert.deepEqual((await call(routes, '/api/registry/claims?status=merged,stale')).body.items.map(c => c.id), ['c2', 'c4']);
  assert.equal((await call(routes, '/api/registry/claims?status=bogus')).code, 400);
});

test('claims lineId and repo filters', async () => {
  const { routes } = await setup();
  assert.deepEqual((await call(routes, '/api/registry/claims?lineId=L2')).body.items.map(c => c.id), ['c3']);
  assert.deepEqual((await call(routes, '/api/registry/claims?status=all&repo=r2')).body.items.map(c => c.id), ['c2']);
});

test('claims q searches visible fields only', async () => {
  const { routes } = await setup();
  assert.deepEqual((await call(routes, '/api/registry/claims?q=ALPHA')).body.items.map(c => c.id), ['c1']);
  assert.deepEqual((await call(routes, '/api/registry/claims?q=api-x')).body.items.map(c => c.id), ['c3']);
  for (const hidden of ['secretkey', 'hiddenev', 'c1', 'active']) {
    assert.equal((await call(routes, `/api/registry/claims?status=all&q=${hidden}`)).body.total, 0, hidden);
  }
});

test('pagination and hasMore', async () => {
  const { routes } = await setup();
  const p1 = (await call(routes, '/api/registry/claims?status=all&pageSize=3')).body;
  assert.equal(p1.items.length, 3);
  assert.equal(p1.hasMore, true);
  const p2 = (await call(routes, '/api/registry/claims?status=all&pageSize=3&page=2')).body;
  assert.equal(p2.items.length, 1);
  assert.equal(p2.hasMore, false);
});

test('invalid paging gives 400', async () => {
  const { routes } = await setup();
  for (const qs of ['page=0', 'page=x', 'pageSize=0', 'pageSize=101', 'pageSize=1.5', 'page=-1']) {
    assert.equal((await call(routes, `/api/registry/claims?${qs}`)).code, 400, qs);
  }
});

test('claim by id: live, archived, missing', async () => {
  const { routes } = await setup();
  const live = await call(routes, '/api/registry/claims/c1');
  assert.equal(live.body.id, 'c1');
  assert.equal(live.body.archived, undefined);
  const old = await call(routes, '/api/registry/claims/a1');
  assert.equal(old.code, 200);
  assert.equal(old.body.archived, true);
  assert.equal((await call(routes, '/api/registry/claims/nope')).code, 404);
});

test('archive list with q and lineId', async () => {
  const { routes } = await setup();
  assert.equal((await call(routes, '/api/registry/archive')).body.total, 1);
  assert.equal((await call(routes, '/api/registry/archive?q=old')).body.total, 1);
  assert.equal((await call(routes, '/api/registry/archive?q=zzz')).body.total, 0);
  assert.equal((await call(routes, '/api/registry/archive?lineId=L2')).body.total, 0);
});

test('requests need lineId and filter by readability, state, q', async () => {
  const { routes } = await setup();
  assert.equal((await call(routes, '/api/registry/requests')).code, 400);
  assert.deepEqual((await call(routes, '/api/registry/requests?lineId=L2')).body.items.map(r => r.id), ['q1']);
  assert.equal((await call(routes, '/api/registry/requests?lineId=L1&state=closed')).body.total, 0);
  assert.equal((await call(routes, '/api/registry/requests?lineId=L1&state=open')).body.total, 1);
  assert.equal((await call(routes, '/api/registry/requests?lineId=L1&q=help')).body.total, 1);
  assert.equal((await call(routes, '/api/registry/requests?lineId=L1&q=zzz')).body.total, 0);
});

test('request by id: 400, 404, 403, 200', async () => {
  const { routes } = await setup();
  assert.equal((await call(routes, '/api/registry/requests/q1')).code, 400);
  assert.equal((await call(routes, '/api/registry/requests/nope?lineId=L1')).code, 404);
  assert.equal((await call(routes, '/api/registry/requests/q2?lineId=L1')).code, 403);
  assert.equal((await call(routes, '/api/registry/requests/q1?lineId=L2')).body.id, 'q1');
});

test('events paging, tooOld, invalid cursor', async () => {
  const { routes } = await setup();
  const r = (await call(routes, '/api/registry/events?after=3&limit=1')).body;
  assert.deepEqual(r.items.map(e => e.cursor), [4]);
  assert.equal(r.hasMore, true);
  assert.equal(r.nextCursor, 4);
  assert.equal(r.tooOld, false);
  assert.equal((await call(routes, '/api/registry/events?after=0')).body.tooOld, true);
  assert.equal((await call(routes, '/api/registry/events?after=abc')).code, 400);
  assert.equal((await call(routes, '/api/registry/events?after=-1')).code, 400);
});

test('summary counts', async () => {
  const { routes } = await setup();
  const s = (await call(routes, '/api/registry/summary')).body;
  assert.deepEqual(s.claimsByStatus, { active: 1, merged: 1, planned: 1, stale: 1 });
  assert.deepEqual(s.claimsByOwner, { L1: 3, L2: 1 });
  assert.deepEqual(s.claimsByRepo, { r1: 3, r2: 1 });
  assert.deepEqual(s.requestsByState, { open: 1, closed: 1 });
  assert.equal(s.archiveCount, 1);
  assert.equal(s.snapshotRevision, 7);
});

test('corrupt store gives 503 and file is not overwritten', async () => {
  const { routes, file } = await setup(null, '{not json');
  const r = await call(routes, '/api/registry/claims');
  assert.equal(r.code, 503);
  assert.equal(r.body.code, 'REGISTRY_UNAVAILABLE');
  assert.equal(r.body.file, file);
  assert.equal(await fs.readFile(file, 'utf8'), '{not json');
});

test('startup-failure state gives 503 with file', async () => {
  const routes = createRegistryRoutes({ store: {}, unavailable: () => ({ error: 'bad', file: '/f' }) });
  const r = await call(routes, '/api/registry/summary');
  assert.deepEqual(r.body, { error: 'bad', code: 'REGISTRY_UNAVAILABLE', file: '/f' });
});

test('unknown route, method and foreign path', async () => {
  const { routes } = await setup();
  assert.equal((await call(routes, '/api/registry/nope')).code, 404);
  assert.equal((await call(routes, '/api/registry/claims', 'POST')).code, 404);
  assert.equal((await call(routes, '/api/registry/claims/c1/extra')).code, 404);
  assert.equal((await call(routes, '/api/registry/claims/bad%20id')).code, 404);
  assert.equal((await call(routes, '/api/other')).handled, false);
});
