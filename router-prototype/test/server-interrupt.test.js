'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('dashboard projection is active for a run and null after close', () => {
  const child = createFakeChild(); const item = line(child);
  assert.equal(dashboardStateForLine(item).activePlannerRunId, 'run-new');
  item.runId = null; assert.equal(dashboardStateForLine(item).activePlannerRunId, null);
});
