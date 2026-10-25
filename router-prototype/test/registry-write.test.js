'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createStore } = require('../work-registry');
const { createRegistryRoutes } = require('../registry-routes');

const SHA = 'a'.repeat(40);
const LINES = new Set(['L1', 'L2']);

async function setup(snap = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-'));
  const file = path.join(dir, 'reg.json');
  const base = { version: 1, revision: 0, eventCursor: 0, claims: [], requests: [], archive: [], events: [], outbox: [], tombstones: [], idempotency: [] };
  await fs.writeFile(file, JSON.stringify({ ...base, ...snap }));
  const store = createStore(file);
  let n = 0;
  const routes = createRegistryRoutes({ store, lineExists: id => LINES.has(id), now: () => 1000, newId: () => `id-${++n}` });
  return { routes, store };
}

function call(routes, method, p, body, raw) {
  const url = new URL(p, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  const data = raw ?? (body === undefined ? '' : JSON.stringify(body));
  const req = Object.assign(Readable.from([Buffer.from(data)]), { method });
  return new Promise(resolve => routes.handle(req, {}, url, parts, (res, code, out) => resolve({ code, body: out })));
}

const newClaim = (o = {}) => ({ title: 'T', repo: 'r', branch: 'b', commit: SHA, ...o });
const mk = (id, o = {}) => ({ id, revision: 1, ownerLineId: 'L1', repo: 'r', branch: 'b', commit: SHA, title: 't', summary: '', tags: [], contract: '', status: 'active', createdAt: 1, updatedAt: 1, confirmedAt: 1, ...o });

test('create claim: 201, id, revision 1, snapshotRevision', async () => {
  const { routes, store } = await setup();
  const r = await call(routes, 'POST', '/api/registry/lines/L1/claims', newClaim());
  assert.equal(r.code, 201);
  assert.equal(r.body.claim.id, 'id-1');
  assert.equal(r.body.claim.revision, 1);
  assert.equal(r.body.claim.ownerLineId, 'L1');
  assert.equal(r.body.snapshotRevision, 1);
  assert.equal((await store.readSnapshot()).claims.length, 1);
});

test('create claim: rule errors, unknown line, bad JSON, oversize', async () => {
  const { routes } = await setup();
  const bad = await call(routes, 'POST', '/api/registry/lines/L1/claims', newClaim({ status: 'merged' }));
  assert.equal(bad.code, 403);
  assert.equal(bad.body.code, 'FORBIDDEN_STATUS');
  assert.equal((await call(routes, 'POST', '/api/registry/lines/L1/claims', { title: 'x' })).body.code, 'MISSING_FIELD');
  const unk = await call(routes, 'POST', '/api/registry/lines/NOPE/claims', newClaim());
  assert.equal(unk.code, 404);
  assert.equal(unk.body.code, 'UNKNOWN_LINE');
  assert.equal((await call(routes, 'POST', '/api/registry/lines/L1/claims', undefined, '{bad')).code, 400);
  assert.equal((await call(routes, 'POST', '/api/registry/lines/L1/claims', undefined, '[]')).code, 400);
  const big = await call(routes, 'POST', '/api/registry/lines/L1/claims', undefined, JSON.stringify({ title: 'x'.repeat(70000) }));
  assert.equal(big.code, 400);
  assert.equal(big.body.code, 'BODY_TOO_LARGE');
  assert.equal((await call(routes, 'DELETE', '/api/registry/lines/L1/claims')).code, 404);
});

test('claim idempotency: replay 200, conflict 409', async () => {
  const { routes, store } = await setup();
  const a = await call(routes, 'POST', '/api/registry/lines/L1/claims', newClaim({ idempotencyKey: 'k1' }));
  const b = await call(routes, 'POST', '/api/registry/lines/L1/claims', newClaim({ idempotencyKey: 'k1' }));
  assert.equal(b.code, 200);
  assert.equal(b.body.claim.id, a.body.claim.id);
  assert.equal((await store.readSnapshot()).claims.length, 1);
  const c = await call(routes, 'POST', '/api/registry/lines/L1/claims', newClaim({ idempotencyKey: 'k1', title: 'Other' }));
  assert.equal(c.code, 409);
  assert.equal(c.body.code, 'IDEMPOTENCY_CONFLICT');
});

test('patch claim: success, stale revision, missing, merged/stale refused, not owner', async () => {
  const { routes } = await setup({ claims: [mk('c1')], revision: 3 });
  const base = '/api/registry/lines/L1/claims/c1';
  const ok = await call(routes, 'PATCH', base, { expectedRevision: 1, title: 'New' });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.claim.revision, 2);
  assert.equal(ok.body.claim.title, 'New');
  assert.equal(ok.body.snapshotRevision, 4);
  const stale = await call(routes, 'PATCH', base, { expectedRevision: 1, title: 'X' });
  assert.equal(stale.code, 409);
  assert.equal(stale.body.code, 'STALE_REVISION');
  assert.equal(stale.body.currentRevision, 2);
  assert.equal((await call(routes, 'PATCH', base, { expectedRevision: 2, status: 'merged' })).code, 403);
  assert.equal((await call(routes, 'PATCH', base, { expectedRevision: 2, status: 'stale' })).body.code, 'FORBIDDEN_STATUS');
  assert.equal((await call(routes, 'PATCH', base, { title: 'x' })).body.code, 'INVALID_FIELD');
  assert.equal((await call(routes, 'PATCH', '/api/registry/lines/L1/claims/zz', { expectedRevision: 1 })).code, 404);
  const other = await call(routes, 'PATCH', '/api/registry/lines/L2/claims/c1', { expectedRevision: 2, title: 'x' });
  assert.equal(other.body.code, 'NOT_OWNER');
});

test('renew and supersede claim', async () => {
  const { routes } = await setup({ claims: [mk('c1', { status: 'stale', staleReason: 'age' }), mk('c2')] });
  const renew = await call(routes, 'POST', '/api/registry/lines/L1/claims/c1/renew', { expectedRevision: 1 });
  assert.equal(renew.code, 200);
  assert.equal(renew.body.claim.status, 'active');
  assert.equal(renew.body.claim.revision, 2);
  assert.equal((await call(routes, 'POST', '/api/registry/lines/L1/claims/c1/renew', { expectedRevision: 2, status: 'merged' })).body.code, 'INVALID_STATUS');
  const sup = await call(routes, 'POST', '/api/registry/lines/L1/claims/c2/supersede', { expectedRevision: 1, byClaimId: 'c1' });
  assert.equal(sup.body.claim.status, 'superseded');
  assert.equal(sup.body.claim.supersededBy, 'c1');
  assert.equal((await call(routes, 'POST', '/api/registry/lines/L1/claims/c2/supersede', { expectedRevision: 2 })).body.code, 'TERMINAL');
});

const reqBody = (o = {}) => ({ targetLineId: 'L2', subject: 'Need', text: 'please', idempotencyKey: 'k', ...o });

test('open request: 201, outbox notice, replay adds nothing, errors', async () => {
  const { routes, store } = await setup();
  const a = await call(routes, 'POST', '/api/registry/lines/L1/requests', reqBody());
  assert.equal(a.code, 201);
  assert.equal(a.body.request.sourceLineId, 'L1');
  let snap = await store.readSnapshot();
  assert.equal(snap.outbox.length, 1);
  assert.equal(snap.outbox[0].recipientLineId, 'L2');
  assert.equal(snap.outbox[0].deliveredAt, null);
  const b = await call(routes, 'POST', '/api/registry/lines/L1/requests', reqBody());
  assert.equal(b.code, 200);
  assert.equal(b.body.request.id, a.body.request.id);
  snap = await store.readSnapshot();
  assert.equal(snap.outbox.length, 1);
  assert.equal(snap.requests.length, 1);
  assert.equal((await call(routes, 'POST', '/api/registry/lines/L1/requests', reqBody({ text: 'diff' }))).body.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await call(routes, 'POST', '/api/registry/lines/L1/requests', reqBody({ targetLineId: 'L1', idempotencyKey: 'z' }))).body.code, 'SELF_REQUEST');
  assert.equal((await call(routes, 'POST', '/api/registry/lines/L1/requests', reqBody({ targetLineId: 'L9', idempotencyKey: 'y' }))).code, 404);
});

test('transition request: reply notice goes to source, errors', async () => {
  const { routes, store } = await setup();
  const a = await call(routes, 'POST', '/api/registry/lines/L1/requests', reqBody());
  const p = `/api/registry/lines/L2/requests/${a.body.request.id}`;
  assert.equal((await call(routes, 'PATCH', `/api/registry/lines/L1/requests/${a.body.request.id}`, { state: 'accepted', expectedRevision: 1 })).body.code, 'NOT_TARGET');
  assert.equal((await call(routes, 'PATCH', p, { state: 'accepted', expectedRevision: 5 })).body.currentRevision, 1);
  const ok = await call(routes, 'PATCH', p, { state: 'accepted', expectedRevision: 1 });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.request.state, 'accepted');
  assert.equal(ok.body.request.revision, 2);
  const snap = await store.readSnapshot();
  assert.equal(snap.requests[0].state, 'accepted');
  assert.equal(snap.outbox.length, 2);
  assert.equal(snap.outbox[1].type, 'request.accepted');
  assert.equal(snap.outbox[1].recipientLineId, 'L1');
  assert.equal((await call(routes, 'PATCH', p, { state: 'declined', expectedRevision: 2 })).body.code, 'ILLEGAL_TRANSITION');
  assert.equal((await call(routes, 'PATCH', '/api/registry/lines/L2/requests/nope', { state: 'accepted', expectedRevision: 1 })).code, 404);
});

test('two quick writes both succeed or one gets structured 409', async () => {
  const { routes, store } = await setup();
  const rs = await Promise.all([
    call(routes, 'POST', '/api/registry/lines/L1/claims', newClaim()),
    call(routes, 'POST', '/api/registry/lines/L2/claims', newClaim({ title: 'U' })),
  ]);
  for (const r of rs) assert.ok(r.code === 201 || (r.code === 409 && r.body.code === 'BUSY'), JSON.stringify(r));
  assert.equal((await store.readSnapshot()).claims.length, rs.filter(r => r.code === 201).length);
});

test('unavailable store gives 503 on writes', async () => {
  const routes = createRegistryRoutes({ store: null });
  assert.equal((await call(routes, 'POST', '/api/registry/lines/L1/claims', newClaim())).code, 503);
});

test('onLineDeleted stales claims, orphans requests, appends events, is idempotent', async () => {
  const { routes, store } = await setup({
    eventCursor: 4,
    claims: [mk('c1'), mk('c2', { status: 'planned' }), mk('c3', { status: 'merged' }), mk('c4', { ownerLineId: 'L2' })],
    requests: [
      { id: 'q1', revision: 1, sourceLineId: 'L1', targetLineId: 'L2', state: 'open' },
      { id: 'q2', revision: 1, sourceLineId: 'L2', targetLineId: 'L1', state: 'accepted' },
      { id: 'q3', revision: 1, sourceLineId: 'L1', targetLineId: 'L2', state: 'fulfilled' },
      { id: 'q4', revision: 1, sourceLineId: 'L2', targetLineId: 'L3', state: 'open' },
    ],
  });
  await routes.onLineDeleted('L1');
  let s = await store.readSnapshot();
  const by = id => s.claims.find(c => c.id === id);
  assert.equal(by('c1').status, 'stale');
  assert.equal(by('c1').staleReason, 'owner-gone');
  assert.equal(by('c2').status, 'stale');
  assert.equal(by('c3').status, 'merged');
  assert.equal(by('c4').status, 'active');
  assert.deepEqual(s.requests.map(r => !!r.orphaned), [true, true, false, false]);
  assert.deepEqual(s.events.map(e => e.cursor), [5, 6, 7, 8]);
  assert.equal(new Set(s.events.map(e => e.id)).size, 4);
  assert.deepEqual(s.events.map(e => e.type), ['claim.stale', 'claim.stale', 'request.orphaned', 'request.orphaned']);
  assert.equal(s.eventCursor, 8);
  const rev = s.revision;
  await routes.onLineDeleted('L1');
  s = await store.readSnapshot();
  assert.equal(s.events.length, 4);
  assert.equal(s.revision, rev);
});
