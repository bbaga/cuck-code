'use strict';

const COALESCE_MS = 250;
const MAX_CLIENTS = 100;

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Live hints only: the payload holds revision and eventCursor, never registry content.
// Clients replay GET /api/registry/events?after= to read the persisted changes.
function createRegistryLive({ log = () => {}, heartbeatMs = 25000, maxClients = MAX_CLIENTS, coalesceMs = COALESCE_MS } = {}) {
  const clients = new Set();
  let latest = null;
  let timer = null;

  function flush() {
    timer = null;
    if (!latest) return;
    const payload = { revision: latest.revision, eventCursor: latest.eventCursor };
    latest = null;
    for (const res of clients) {
      try { send(res, 'registry', payload); } catch (error) { log('registry.live.send_failed', { error: String(error && error.message) }); }
    }
  }

  function notify(state) {
    if (!state) return;
    latest = { revision: state.revision, eventCursor: state.eventCursor };
    if (timer) return;
    timer = setTimeout(flush, coalesceMs);
    timer.unref();
  }

  function attach(req, res, state) {
    if (clients.size >= maxClients) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many registry stream clients', code: 'STREAM_LIMIT' }));
      return false;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    clients.add(res);
    const beat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { cleanup(); }
    }, heartbeatMs);
    beat.unref();
    function cleanup() { clearInterval(beat); clients.delete(res); }
    req.on('close', cleanup);
    try { send(res, 'hello', { revision: state.revision, eventCursor: state.eventCursor }); } catch { cleanup(); }
    return true;
  }

  return { attach, notify, size: () => clients.size };
}

module.exports = { createRegistryLive };
