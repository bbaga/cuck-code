"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createDashboardLive } = require("../dashboard-live");

function client() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.headers = null;
  res.messages = [];
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.write = (message) => { res.messages.push(message); return true; };
  res.end = () => { res.ended = true; };
  return { req, res };
}

function envelope(message) {
  return JSON.parse(message.match(/^data: (.*)$/m)[1]);
}

test("dashboard stream bootstraps and tags published events with their line", () => {
  const live = createDashboardLive({ heartbeatMs: 60_000 });
  const a = client();
  assert.equal(live.attach(a.req, a.res, (send) => {
    send("snapshot_begin", null, { lines: [{ id: "line-a" }] });
    send("state", "line-a", { id: "line-a" });
    send("snapshot_end", null, {});
  }), true);
  live.publish("worker_status", "line-a", { workerId: "worker-1", status: "running" });
  assert.equal(a.res.headers["Content-Type"], "text/event-stream");
  assert.deepEqual(a.res.messages.map(envelope).map((e) => [e.type, e.lineId]), [
    ["snapshot_begin", null], ["state", "line-a"], ["snapshot_end", null],
    ["worker_status", "line-a"],
  ]);
  a.req.emit("close");
  assert.equal(live.size(), 0);
});

test("large snapshots pause generation on backpressure without hitting the live buffer limit", () => {
  const live = createDashboardLive({ heartbeatMs: 60_000, maxBufferedBytes: 1024 });
  const a = client();
  let generated = 0;
  a.res.write = (message) => { a.res.messages.push(message); return false; };
  live.attach(a.req, a.res, function* () {
    yield ["snapshot_begin", null, { lines: [] }];
    for (let i = 0; i < 5; i++) {
      generated++;
      yield ["state", `line-${i}`, { payload: "x".repeat(1024 * 1024) }];
    }
    yield ["snapshot_end", null, {}];
  });
  assert.equal(generated, 0, "do not eagerly serialize the rest of the snapshot");
  live.publish("status", "line-4", { status: "idle" });
  for (let i = 0; i < 8; i++) a.res.emit("drain");
  assert.equal(generated, 5);
  assert.equal(live.size(), 1);
  assert.equal(a.res.ended, undefined);
  assert.deepEqual(a.res.messages.map(envelope).map((e) => e.type), [
    "snapshot_begin", "state", "state", "state", "state", "state", "snapshot_end", "status",
  ]);
  a.req.emit("close");
  live.close();
});

test("disconnect stops a paused snapshot and live-event overflow remains bounded", () => {
  const live = createDashboardLive({ heartbeatMs: 60_000, maxBufferedBytes: 100 });
  const a = client();
  let closed = false;
  a.res.write = (message) => { a.res.messages.push(message); return false; };
  live.attach(a.req, a.res, function* () {
    try {
      yield ["snapshot_begin", null, { lines: [] }];
      yield ["snapshot_end", null, {}];
    } finally { closed = true; }
  });
  live.publish("entry", "line-a", { text: "x".repeat(200) });
  assert.equal(live.size(), 0);
  assert.equal(a.res.ended, true);
  assert.equal(closed, true);
  a.res.emit("drain");
  assert.equal(a.res.messages.length, 1);
});

test("a disconnected client does not receive later events", () => {
  const live = createDashboardLive({ heartbeatMs: 60_000 });
  const a = client();
  live.attach(a.req, a.res, () => {});
  a.req.emit("close");
  live.publish("status", "line-a", { status: "idle" });
  assert.equal(a.res.messages.length, 0);
});
