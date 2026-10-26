"use strict";

function frame(type, lineId, data) {
  return `event: dashboard\ndata: ${JSON.stringify({ version: 1, type, lineId, data })}\n\n`;
}

function createDashboardLive({ log = () => {}, heartbeatMs = 25000, maxClients = 100,
  maxBufferedBytes = 1024 * 1024 } = {}) {
  const clients = new Set();

  function remove(client, reason) {
    if (!clients.delete(client)) return;
    clearInterval(client.heartbeat);
    client.res.off("drain", client.drain);
    log("dashboard.sse.close", { clients: clients.size, reason });
  }

  function write(client, message) {
    if (!clients.has(client)) return;
    if (client.blocked) {
      client.queue.push(message);
      client.queuedBytes += Buffer.byteLength(message);
      if (client.queuedBytes > maxBufferedBytes) {
        log("dashboard.sse.slow_client", { clients: clients.size, queuedBytes: client.queuedBytes });
        try { client.res.end(); } catch {}
        remove(client, "slow-client");
      }
      return;
    }
    try {
      if (!client.res.write(message)) client.blocked = true;
    } catch {
      remove(client, "write-failed");
    }
  }

  function flush(client) {
    client.blocked = false;
    while (clients.has(client) && client.queue.length) {
      const message = client.queue.shift();
      client.queuedBytes -= Buffer.byteLength(message);
      try {
        if (!client.res.write(message)) {
          client.blocked = true;
          return;
        }
      } catch {
        remove(client, "write-failed");
        return;
      }
    }
  }

  function attach(req, res, initialize) {
    if (clients.size >= maxClients) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many dashboard stream clients", code: "STREAM_LIMIT" }));
      return false;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no" });
    const client = { res, blocked: false, queue: [], queuedBytes: 0, heartbeat: null, drain: null };
    client.drain = () => flush(client);
    res.on("drain", client.drain);
    client.heartbeat = setInterval(() => write(client, ": ping\n\n"), heartbeatMs);
    client.heartbeat.unref();
    clients.add(client);
    req.on("close", () => remove(client, "request-closed"));
    try { initialize((type, lineId, data) => write(client, frame(type, lineId, data))); }
    catch (error) {
      log("dashboard.sse.bootstrap_failed", { error: String(error && error.message) });
      try { res.end(); } catch {}
      remove(client, "bootstrap-failed");
      return false;
    }
    log("dashboard.sse.open", { clients: clients.size });
    return true;
  }

  function publish(type, lineId, data) {
    const message = frame(type, lineId, data);
    for (const client of [...clients]) write(client, message);
  }

  function close() {
    for (const client of [...clients]) {
      try { client.res.end(); } catch {}
      remove(client, "shutdown");
    }
  }

  return { attach, publish, close, size: () => clients.size };
}

module.exports = { createDashboardLive };
