'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStore } = require('../work-registry');
const { createRegistryLive } = require('../registry-live');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function client() {
  const req = new EventEmitter();
  const res = { chunks: [], status: null, headers: null, ended: false, writeHead(s, h) { this.status = s; this.headers = h; }, write(c) { this.chunks.push(c); }, end(c) { this.ended = true; if (c) this.chunks.push(c); } };
  return { req, res };
}
const regs = c => c.res.chunks.filter(x => x.startsWith('event: registry'));
async function setup(t, opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-live-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const live = createRegistryLive(opts);
  const store = createStore(path.join(dir, 'r.json'), { onCommit: s => live.notify(s) });
  return { live, store, dir };
}

test('onCommit: once per commit; not on stale, abort or write failure; throw ignored', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-commit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [];
  const store = createStore(path.join(dir, 'r.json'), { onCommit: s => { calls.push(s); throw new Error('boom'); } });
  const out = await store.createClaim(0, { title: 'A' });
  assert.equal(out.ok, true);
  assert.deepEqual(calls, [{ revision: 1, eventCursor: 0 }]);
  await store.createClaim(0, { title: 'B' }); // stale
  await assert.rejects(store.transact(null, () => { throw new Error('abort'); }));
  const blocked = createStore(path.join(dir, 'blocked', 'r.json'), { onCommit: s => calls.push(s) });
  await fs.writeFile(path.join(dir, 'blocked'), 'file'); // mkdir fails
  await assert.rejects(blocked.createClaim(0, { title: 'C' }));
  assert.equal(calls.length, 1);
});

test('onCommit: a rejected promise from a listener is caught and the commit succeeds', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-reject-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const logged = t.mock.method(console, 'error', () => {});
  const unhandled = [];
  const onUnhandled = e => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const store = createStore(path.join(dir, 'r.json'), { onCommit: async () => { throw new Error('async boom'); } });
  const out = await store.createClaim(0, { title: 'A' });
  assert.equal(out.ok, true);
  await sleep(20);
  assert.equal(logged.mock.callCount(), 1);
  assert.deepEqual(unhandled, []);
});

test('attach writes headers and hello; close removes client and heartbeat', async t => {
  const { live } = await setup(t, { heartbeatMs: 10 });
  const c = client();
  assert.equal(live.attach(c.req, c.res, { revision: 3, eventCursor: 2 }), true);
  assert.equal(c.res.status, 200);
  assert.equal(c.res.headers['Content-Type'], 'text/event-stream');
  assert.equal(c.res.chunks[0], 'event: hello\ndata: {"revision":3,"eventCursor":2}\n\n');
  await sleep(35);
  assert.ok(c.res.chunks.some(x => x.startsWith(': heartbeat')));
  c.req.emit('close');
  assert.equal(live.size(), 0);
  const n = c.res.chunks.length;
  await sleep(35);
  assert.equal(c.res.chunks.length, n);
});

test('commit reaches all clients with only two fields; bursts coalesce', async t => {
  const { live, store } = await setup(t);
  const a = client(), b = client();
  live.attach(a.req, a.res, { revision: 0, eventCursor: 0 });
  live.attach(b.req, b.res, { revision: 0, eventCursor: 0 });
  await store.createClaim(0, { title: 'one' });
  await store.createClaim(null, { title: 'two' });
  await store.createClaim(null, { title: 'three' });
  await sleep(300);
  for (const c of [a, b]) {
    assert.equal(regs(c).length, 1);
    assert.equal(regs(c)[0], 'event: registry\ndata: {"revision":3,"eventCursor":0}\n\n');
  }
  await store.createClaim(null, { title: 'four' });
  await sleep(300);
  assert.equal(regs(a).length, 2);
  assert.match(regs(a)[1], /"revision":4/);
});

test('no message on stale, abort or write failure', async t => {
  const { live, store } = await setup(t);
  const c = client();
  live.attach(c.req, c.res, { revision: 0, eventCursor: 0 });
  await store.createClaim(5, { title: 'stale' });
  await assert.rejects(store.transact(null, () => { throw new Error('abort'); }));
  await sleep(300);
  assert.equal(regs(c).length, 0);
});

test('client limit returns 503', async t => {
  const { live } = await setup(t, { maxClients: 1 });
  live.attach(client().req, client().res, { revision: 0, eventCursor: 0 });
  const extra = client();
  assert.equal(live.attach(extra.req, extra.res, { revision: 0, eventCursor: 0 }), false);
  assert.equal(extra.res.status, 503);
  assert.equal(extra.res.ended, true);
});
