'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const { startDashboardFixture, CSP } = require('./dashboard-browser');

let fx; let dir; let first; let queued = [];

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(fx.url + path, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const json = (r) => JSON.parse(r.data);
const prompt = (text) => call('POST', `/api/lines/${fx.lineId}/prompts`, { text });
const texts = () => fx.controls.state().queuedUserPrompts.map((p) => p.text);

before(async () => { fx = await startDashboardFixture(); dir = process.env.LINES_DIR; });
after(() => fx.close());

test('GET / returns the dashboard with the CSP header', async () => {
  const res = await call('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /html/);
  assert.equal(res.headers['content-security-policy'], CSP);
});

test('GET /api/lines lists the seeded line', async () => {
  const res = await call('GET', '/api/lines');
  assert.equal(res.status, 200);
  assert.ok(JSON.stringify(json(res)).includes(fx.lineId));
});

test('first prompt returns 202 and starts one fake child', async () => {
  const res = await prompt('first');
  assert.equal(res.status, 202);
  first = json(res);
  assert.equal(typeof first.requestId, 'string');
  assert.equal(fx.controls.spawnCount(), 1);
});

test('two more prompts queue in order during the run', async () => {
  for (const t of ['second', 'third']) {
    const res = await prompt(t); assert.equal(res.status, 202); queued.push(json(res).requestId);
  }
  assert.deepEqual(texts(), ['second', 'third']);
  assert.equal(typeof fx.controls.state().activePlannerRunId, 'string');
  assert.equal(fx.controls.spawnCount(), 1);
});

test('GET /api/events delivers a state event with the same queue', async () => {
  const body = await new Promise((resolve, reject) => {
    const req = http.get(fx.url + '/api/events', (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.includes('snapshot_end')) { req.destroy(); resolve(data); } });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
  });
  assert.match(body, /"type":"state"/);
  assert.ok(body.includes('"second"') && body.includes('"third"'));
});

test('DELETE of one queued prompt keeps the other', async () => {
  const res = await call('DELETE', `/api/lines/${fx.lineId}/prompts/${queued[0]}`);
  assert.equal(res.status, 200);
  assert.deepEqual(json(res).queuedUserPrompts.map((p) => p.text), ['third']);
});

test('interrupt with the active runId returns 202 and sends SIGTERM', async () => {
  const runId = fx.controls.state().activePlannerRunId;
  const res = await call('POST', `/api/lines/${fx.lineId}/interrupt`, { runId });
  assert.equal(res.status, 202);
  assert.deepEqual(fx.controls.signals(), ['SIGTERM']);
});

test('closeActive starts the next queued prompt once', async () => {
  fx.controls.closeActive(0);
  assert.equal(fx.controls.spawnCount(), 2);
  assert.deepEqual(texts(), []);
  fx.controls.emitOutput('hello');
});

test('an unknown remote-style path returns 404 in the error shape', async () => {
  const res = await call('GET', '/http://example.com/x');
  assert.equal(res.status, 404);
  assert.equal(typeof json(res).error, 'string');
});

test('close frees the port, ends SSE streams, and removes the directory; second close is harmless', async () => {
  const port = new URL(fx.url).port;
  let markEnded; const ended = new Promise((r) => { markEnded = r; });
  const sse = http.get(fx.url + '/api/events', (res) => {
    res.on('data', () => {}); res.on('close', markEnded); res.on('error', () => {});
  });
  sse.on('error', markEnded);
  await new Promise((r) => setTimeout(r, 100));
  await fx.close();
  await fx.close();
  await ended;
  assert.equal(fs.existsSync(dir), false);
  await new Promise((resolve, reject) => {
    const probe = net.connect(Number(port), '127.0.0.1');
    probe.on('connect', () => { probe.destroy(); reject(new Error('port still open')); });
    probe.on('error', resolve);
  });
});
