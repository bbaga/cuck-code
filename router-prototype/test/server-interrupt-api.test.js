'use strict';
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createFakeClock } = require('./fixtures/fake-clock');
const { createFakeChild } = require('./fixtures/planner-child');

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'router-interrupt-api-'));
process.env.LINES_DIR = state;
const server = require('../server');
const { pump, lines, dashboardStateForLine, setSpawnForTest, setTimerForTest, setLifecycleHooksForTest } = server;
let app; let port; let spawned; let clock; let errors;

function makeLine(id = 'line-api') {
  const item = { id, name: id, status: 'idle', child: null, activePlannerRun: null, runId: null,
    deleted: false, compacting: false, queue: [], transcript: [], workers: new Map(),
    clients: new Set(), inventory: new Map(), repos: new Map(), pendingValidations: [],
    sessionId: null, sessionCfg: null, context: null, started: true, planApproved: true,
    workdir: state, pipeline: null, lastRun: null, activePlannerRequest: null };
  lines.set(id, item);
  return item;
}
function enqueue(item, id) { item.queue.push({ id, text: id, source: null, fromUser: false, recorded: true }); }
function post(urlPath, raw) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, method: 'POST', path: urlPath,
      headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject); req.end(raw);
  });
}
const interrupt = (runId, id = 'line-api') => post(`/api/lines/${id}/interrupt`, JSON.stringify({ runId }));

beforeEach(async () => {
  lines.clear(); spawned = [];
  clock = createFakeClock(); errors = [];
  setTimerForTest(clock);
  setLifecycleHooksForTest({ broadcast: (item, event, data) => { if (event === 'error') errors.push(data.message); } });
  setSpawnForTest(() => { const child = createFakeChild(); spawned.push(child); return child; });
  if (!app) await new Promise((resolve) => { app = server.createServer().listen(0, () => { port = app.address().port; resolve(); }); });
});
after(async () => {
  setTimerForTest(null); setLifecycleHooksForTest(null);
  if (app) await new Promise((resolve) => app.close(resolve));
  fs.rmSync(state, { recursive: true, force: true });
});

test('invalid bodies return 400', async () => {
  const item = makeLine(); enqueue(item, 'a'); pump(item);
  const url = '/api/lines/line-api/interrupt';
  for (const raw of [undefined, '', '[]', 'null', '"x"', '7', '{bad', '{}', '{"runId":5}', '{"runId":null}',
    '{"runId":""}', '{"runId":"   "}', '{"runId":"\\t\\n"}', '{"runId":["a"]}', '{"runId":{"a":1}}', `{"runId":"${item.runId}","extra":1}`, '{"other":"x"}']) {
    const res = await post(url, raw);
    assert.equal(res.status, 400, String(raw));
    assert.equal(typeof res.body.error, 'string');
  }
  assert.deepEqual(spawned[0].signals, []);
});

test('unknown line returns 404, and the body is checked first', async () => {
  assert.equal((await interrupt('x', 'missing')).status, 404);
  assert.equal((await post('/api/lines/missing/interrupt', '{}')).status, 400);
});

test('idle and compacting lines return 409', async () => {
  const item = makeLine();
  assert.equal((await interrupt('x')).status, 409);
  enqueue(item, 'a'); pump(item);
  const runId = item.runId; item.compacting = true;
  const res = await interrupt(runId);
  assert.equal(res.status, 409); assert.match(res.body.error, /compacting/);
  assert.deepEqual(spawned[0].signals, []);
});

test('stale run ID returns 409 and sends no signal', async () => {
  const item = makeLine(); enqueue(item, 'a'); pump(item);
  const res = await interrupt('stale-run');
  assert.equal(res.status, 409);
  assert.deepEqual(spawned[0].signals, []);
  assert.equal(item.activePlannerRun.intentionalStop, false);
});

test('matching run returns 202 with the dashboard run ID and signals once', async () => {
  const item = makeLine(); enqueue(item, 'a'); pump(item);
  const runId = dashboardStateForLine(item).activePlannerRunId;
  assert.equal(runId, item.activePlannerRun.runId);
  const res = await interrupt(runId);
  assert.equal(res.status, 202); assert.deepEqual(res.body, { runId });
  assert.deepEqual(spawned[0].signals, ['SIGTERM']);
  const again = await interrupt(runId);
  assert.equal(again.status, 409); assert.match(again.body.error, /already stopping/);
  assert.deepEqual(spawned[0].signals, ['SIGTERM']);
  assert.equal(dashboardStateForLine(item).activePlannerRunId, runId);
});

test('a request for run X never signals run Y', async () => {
  const item = makeLine(); enqueue(item, 'x'); pump(item);
  const runX = item.runId;
  spawned[0].emitClose(0, null);
  enqueue(item, 'y'); pump(item);
  assert.notEqual(item.runId, runX);
  const res = await interrupt(runX);
  assert.equal(res.status, 409);
  assert.deepEqual(spawned[1].signals, []);
  assert.equal(item.activePlannerRun.intentionalStop, false);
});

test('line stays running after 202 until close, then the queue starts exactly once', async () => {
  const item = makeLine(); enqueue(item, 'a'); enqueue(item, 'b'); pump(item);
  assert.equal((await interrupt(item.runId)).status, 202);
  assert.equal(item.status, 'running'); assert.equal(spawned.length, 1);
  spawned[0].emitClose(null, 'SIGTERM');
  assert.equal(spawned.length, 2);
  assert.equal(item.status, 'running'); assert.equal(item.queue.length, 0);
  assert.deepEqual(spawned[1].signals, []);
});

test('endpoint stop escalates to SIGKILL, reports nonexit, and close starts the queue once', async () => {
  const item = makeLine(); enqueue(item, 'a'); enqueue(item, 'b'); pump(item);
  const first = spawned[0];
  assert.equal((await interrupt(item.runId)).status, 202);
  assert.deepEqual(first.signals, ['SIGTERM']);
  clock.advance(2000);
  assert.deepEqual(first.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(errors.length, 0);
  clock.advance(2000);
  assert.equal(errors.length, 1); assert.match(errors[0], /did not terminate.*retry/);
  first.emitClose(null, 'SIGKILL');
  clock.advance(10000);
  assert.deepEqual(first.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(errors.length, 1);
  assert.equal(spawned.length, 2); assert.deepEqual(spawned[1].signals, []);
});
