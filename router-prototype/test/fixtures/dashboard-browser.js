'use strict';
// Real dashboard and server on 127.0.0.1 with a fake planner child and fake clock.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createFakeClock } = require('./fake-clock');
const { createFakeChild } = require('./planner-child');

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";
const LINE_ID = 'browser-line';

async function startDashboardFixture({ port = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-browser-'));
  process.env.LINES_DIR = dir;
  const server = require('../../server');
  const { lines, requestHandler, dashboardStateForLine, setSpawnForTest, setTimerForTest } = server;
  const clock = createFakeClock();
  const children = [];
  setTimerForTest(clock);
  setSpawnForTest(() => { const child = createFakeChild(); children.push(child); return child; });
  lines.clear();
  const line = { id: LINE_ID, name: 'Browser line', status: 'idle', child: null, activePlannerRun: null,
    runId: null, deleted: false, compacting: false, queue: [], transcript: [], workers: new Map(),
    clients: new Set(), inventory: new Map(), repos: new Map(), pendingValidations: [],
    sessionId: null, sessionCfg: null, context: null, started: true, planApproved: true,
    workdir: dir, pipeline: null, lastRun: null, activePlannerRequest: null };
  lines.set(LINE_ID, line);

  const sockets = new Set();
  const http1 = http.createServer((req, res) => {
    res.setHeader('Content-Security-Policy', CSP);
    requestHandler(req, res);
  });
  http1.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  try {
    await new Promise((resolve, reject) => {
      http1.once('error', reject);
      http1.listen(port, '127.0.0.1', resolve);
    });
  } catch (err) {
    setSpawnForTest(null); setTimerForTest(null); lines.clear();
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const url = `http://127.0.0.1:${http1.address().port}`;
  const active = () => children[children.length - 1];
  let closed = null;

  const controls = {
    emitOutput(text) {
      const child = active();
      if (!child) throw new Error('no active fake child');
      // The seeded line uses the default vibe harness: one JSON message per line.
      child.stdout.write(JSON.stringify({ type: 'message', role: 'assistant', content: String(text),
        sessionId: 'fixture-session' }) + '\n');
    },
    closeActive(code = 0) {
      const child = active();
      if (!child) throw new Error('no active fake child');
      child.emitClose(code);
    },
    advance: (ms) => clock.advance(ms),
    signals: () => (active() ? [...active().signals] : []),
    spawnCount: () => children.length,
    state: () => dashboardStateForLine(line),
  };

  function close() {
    if (closed) return closed;
    closed = new Promise((resolve) => {
      for (const res of line.clients) { try { res.end(); } catch {} }
      http1.close(() => {
        setSpawnForTest(null); setTimerForTest(null); lines.clear();
        fs.rmSync(dir, { recursive: true, force: true });
        resolve();
      });
      for (const socket of sockets) socket.destroy();
    });
    return closed;
  }
  return { url, lineId: LINE_ID, controls, close };
}

module.exports = { startDashboardFixture, CSP };

if (require.main === module) {
  const port = Number(process.env.PORT || 0);
  startDashboardFixture({ port }).then((fx) => {
    console.log(fx.url);
    const stop = () => { fx.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }).catch((err) => { console.error(err.message); process.exit(1); });
}
