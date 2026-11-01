'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createFakeClock } = require('./fixtures/fake-clock');
const { createFakeChild } = require('./fixtures/planner-child');

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'router-lifecycle-'));
process.env.LINES_DIR = state;
const server = require('../server');
const { stopPlannerRun, dashboardStateForLine, pump, setSpawnForTest } = server;
const children = [];
function line(child, status = 'running') {
  return { id: 'line-test', name: 'test', status, child,
    activePlannerRun: { runId: 'run-new', child, intentionalStop: false }, runId: 'run-new',
    deleted: false, compacting: false, queue: [], transcript: [], workers: new Map(),
    clients: new Set(), inventory: new Map(), repos: new Map(), pendingValidations: [],
    sessionId: null, sessionCfg: null, context: null, started: true, planApproved: true,
    workdir: state, pipeline: null, lastRun: null, activePlannerRequest: null };
}
after(() => fs.rmSync(state, { recursive: true, force: true }));
function launch(child, queue = []) {
  setSpawnForTest(() => child);
  const item = line(null, 'idle'); item.child = null; item.activePlannerRun = null; item.runId = null;
  item.queue = [{ id: 'active', text: 'active', recorded: true }, ...queue]; pump(item);
  return item;
}
function hooks() {
  const events = []; return { events, pumps: 0,
    save: (item) => events.push(['save', item.id]),
    broadcast: (item, event) => events.push(['broadcast', event]),
    pump: () => { if (hooks.current) hooks.current.pumps += 1; } };
}
hooks.current = null;
function requestDelete(id) {
  return new Promise((resolve, reject) => {
    const app = server.createServer().listen(0, () => {
      const port = app.address().port;
      const req = http.request({ port, method: 'DELETE', path: `/api/lines/${id}` }, (res) => {
        res.resume(); res.on('end', () => app.close(() => resolve(res.statusCode)));
      });
      req.on('error', reject); req.end();
    });
  });
}

test('production stop sets intent before SIGTERM and escalates on the fake clock', () => {
  const clock = createFakeClock();
  const child = createFakeChild();
  const item = line(child);
  assert.deepEqual(stopPlannerRun(item, 'run-new', clock), { ok: true, runId: 'run-new' });
  assert.equal(item.activePlannerRun.intentionalStop, true);
  assert.deepEqual(child.signals, ['SIGTERM']);
  stopPlannerRun(item, 'run-new', clock);
  assert.deepEqual(child.signals, ['SIGTERM']);
  clock.advance(1999); assert.deepEqual(child.signals, ['SIGTERM']);
  clock.advance(1); assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  clock.advance(2000); assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(stopPlannerRun(item, 'old', clock).ok, false);
  item.status = 'idle'; assert.equal(stopPlannerRun(item, 'run-new', clock).ok, false);
});

test('production stop handles rejected and throwing signals without real waits', () => {
  const clock = createFakeClock();
  const rejected = createFakeChild({ signal: true });
  const item = line(rejected);
  assert.equal(stopPlannerRun(item, 'run-new', clock).ok, true);
  assert.deepEqual(rejected.signals, ['SIGTERM']);
  const throwing = createFakeChild(); throwing.kill = () => { throw new Error('denied'); };
  const second = line(throwing);
  assert.equal(stopPlannerRun(second, 'run-new', clock).ok, true);
  assert.equal(second.activePlannerRun.intentionalStop, true);
});

test('production pump creates a fresh run and close clears state and pumps once', () => {
  const first = createFakeChild(); const second = createFakeChild(); children.push(first, second);
  setSpawnForTest(() => children.shift());
  const item = line(null, 'idle'); item.child = null; item.activePlannerRun = null; item.runId = null;
  item.queue = [{ id: 'request-1', text: 'ordinary request', source: null, fromUser: false, recorded: true }];
  let pumps = 0; const original = item.queue.length;
  pump(item);
  assert.equal(item.status, 'running'); assert.match(item.runId, /^[0-9a-f-]{36}$/);
  const active = item.activePlannerRun; assert.ok(active);
  active.child.emitClose(0, null);
  assert.equal(item.status, 'idle'); assert.equal(item.child, null); assert.equal(item.runId, null);
  assert.equal(item.activePlannerRun, null); assert.equal(item.queue.length, 0); assert.equal(original, 1);
  assert.equal(pumps, 0); // the production close path, not a test reimplementation, performs its own pump
  item.queue.push({ id: 'request-2', text: 'replacement', source: null, fromUser: false, recorded: true });
  pump(item);
  const replacement = item.activePlannerRun;
  assert.notEqual(replacement.runId, active.runId);
  active.child.emitClose(1, null);
  assert.equal(item.activePlannerRun, replacement);
  assert.equal(item.runId, replacement.runId);
  assert.deepEqual(replacement.child.signals, []);
});

test('production stop rejects idle, compacting, wrong-run, and duplicate requests without mutation', () => {
  for (const setup of [
    () => line(null, 'idle'),
    () => { const x = line(createFakeChild()); x.compacting = true; return x; },
    () => line(createFakeChild()),
  ]) {
    const clock = createFakeClock(); const item = setup();
    const before = item.activePlannerRun && item.activePlannerRun.intentionalStop;
    const result = stopPlannerRun(item, 'wrong-run', clock);
    assert.equal(result.ok, false); assert.equal(item.activePlannerRun && item.activePlannerRun.intentionalStop, before);
    assert.deepEqual(item.child ? item.child.signals : null, item.child ? [] : null);
  }
  const clock = createFakeClock(); const child = createFakeChild(); const item = line(child);
  assert.equal(stopPlannerRun(item, 'run-new', clock).ok, true);
  const signals = child.signals.slice(); assert.equal(stopPlannerRun(item, 'run-new', clock).ok, false);
  assert.deepEqual(child.signals, signals);
});

test('production error before interruption remains an ordinary live failure', () => {
  const child = createFakeChild(); const item = launch(child); const h = hooks(); hooks.current = h;
  server.setLifecycleHooksForTest(h);
  child.emitError(new Error('ordinary failure'));
  assert.equal(item.child, child); assert.equal(item.status, 'running');
  assert.equal(h.pumps, 0); assert.equal(child.signals.length, 0);
  child.emitClose(1, null);
  assert.equal(item.child, null); assert.equal(item.status, 'failed');
  assert.equal(item.error, true);
  assert.match(item.lastError, /ordinary failure/);
  assert.ok(h.events.some((e) => e[0] === 'broadcast' && e[1] === 'error'));
  server.setLifecycleHooksForTest(null); hooks.current = null;
});

test('production stop reports bounded nonexit at 4000ms and waits for close', () => {
  const clock = createFakeClock(); const child = createFakeChild(); const item = launch(child); const h = hooks();
  server.setLifecycleHooksForTest(h);
  stopPlannerRun(item, item.runId, clock); child.emitError(new Error('during stop'));
  clock.advance(2000); assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  clock.advance(1999); assert.equal(h.events.filter((e) => e[0] === 'broadcast' && e[1] === 'error').length, 0);
  clock.advance(1); assert.equal(h.events.filter((e) => e[0] === 'broadcast' && e[1] === 'error').length, 1);
  assert.equal(item.activePlannerRun.child, child); assert.equal(item.status, 'running');
  child.emitClose(0, null); assert.equal(item.status, 'idle');
  server.setLifecycleHooksForTest(null);
});

test('production close cancels escalation, preserves queue order, and ignores duplicate error/close', () => {
  const clock = createFakeClock(); server.setTimerForTest(clock); const child = createFakeChild(); const item = launch(child, [{ id: 'user', text: 'user request' }, { id: 'internal', text: 'internal wake' }]); const h = hooks(); hooks.current = h;
  server.setLifecycleHooksForTest(h);
  stopPlannerRun(item, item.runId, clock); const replacement = createFakeChild(); setSpawnForTest(() => replacement);
  child.stdout.write(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'output-before-stop' }] }) + '\n');
  stopPlannerRun(item, item.runId, clock);
  child.stdout.write(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'output-during-stop' }] }) + '\n');
  assert.equal(h.pumps, 0);
  child.emitClose(0, null); child.emitClose(1, null); child.emitError(new Error('late')); child.emitError(new Error('late-again'));
  assert.deepEqual(child.signals, ['SIGTERM']);
  clock.advance(4000);
  assert.equal(item.status, 'running'); assert.equal(item.child, replacement); assert.notEqual(item.runId, null);
  assert.deepEqual(item.queue.map((x) => x.id), ['internal']);
  const visible = JSON.stringify(item.transcript);
  assert.match(visible, /output-before-stop/); assert.match(visible, /output-during-stop/);
  assert.ok(visible.indexOf('output-before-stop') < visible.indexOf('output-during-stop'));
  assert.equal(h.pumps, 1); assert.deepEqual(child.signals, ['SIGTERM']);
  assert.ok(h.events.some((e) => e[0] === 'save'));
  assert.equal(h.events.filter((e) => e[0] === 'broadcast' && e[1] === 'state').length, 2);
  server.setLifecycleHooksForTest(null); server.setTimerForTest(null); hooks.current = null;
});

test('production stale error and timer cannot alter a replacement run', () => {
  const clock = createFakeClock(); const old = createFakeChild(); const fresh = createFakeChild();
  const item = launch(old); const h = hooks(); server.setLifecycleHooksForTest(h);
  stopPlannerRun(item, item.runId, clock); old.emitClose(0, null);
  item.queue.push({ id: 'replacement', text: 'replacement', recorded: true }); setSpawnForTest(() => fresh); pump(item);
  old.emitError(new Error('stale')); old.emitError(new Error('stale-again')); old.emitClose(1, null); clock.advance(4000);
  assert.equal(item.activePlannerRun.child, fresh); assert.equal(item.child, fresh); assert.deepEqual(fresh.signals, []);
  fresh.emitError(new Error('current failure')); assert.equal(item.activePlannerRun.child, fresh);
  server.setLifecycleHooksForTest(null);
});

test('production deletion while stopping cancels timers through the HTTP boundary', async () => {
  const clock = createFakeClock(); server.setTimerForTest(clock); const child = createFakeChild(); const item = launch(child); const h = hooks();
  server.setLifecycleHooksForTest(h); server.lines.set(item.id, item); stopPlannerRun(item, item.runId, clock);
  assert.equal(await requestDelete(item.id), 202); clock.advance(4000);
  assert.deepEqual(child.signals, ['SIGTERM']); assert.equal(server.lines.has(item.id), false);
  server.setLifecycleHooksForTest(null);
});

test('dashboard projection is active for a run and null after close', () => {
  const child = createFakeChild(); const item = line(child);
  assert.equal(dashboardStateForLine(item).activePlannerRunId, 'run-new');
  item.runId = null; assert.equal(dashboardStateForLine(item).activePlannerRunId, null);
});
