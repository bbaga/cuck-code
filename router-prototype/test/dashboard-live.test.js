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

test("a disconnected client does not receive later events", () => {
  const live = createDashboardLive({ heartbeatMs: 60_000 });
  const a = client();
  live.attach(a.req, a.res, () => {});
  a.req.emit("close");
  live.publish("status", "line-a", { status: "idle" });
  assert.equal(a.res.messages.length, 0);
});
