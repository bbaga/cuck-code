# Implementation plan: one dashboard stream over HTTP/2

## 1. Target architecture

```text
Browser
  https://localhost:7789
    │
    │ HTTP/2 over TLS
    │ ├── GET /api/events    ← one persistent SSE stream per tab
    │ ├── API requests
    │ └── HTML / JavaScript / evidence assets
    ▼
Node HTTP/2 TLS listener
  HTTPS_PORT=7789

Node HTTP/1.1 listener
  PORT=7788 (workers, CLI clients, and tests)
```

### Decisions

- Use one shared SSE connection per dashboard tab, not per line.
- Include `lineId` in every line-specific event.
- Enable browser-facing HTTP/2 directly through Node's `node:http2` TLS listener.
- Keep the existing Node HTTP listener for workers, CLI tools, and tests.
- Keep all browser requests same-origin, using relative URLs.
- Make the shared stream work over HTTP/1.1 too; HTTP/2 improves transport, but does not determine correctness.

Keep the existing HTTP listener so worker instructions that call `http://localhost:${PORT}` do not require TLS or URL changes.

### Diagnosis motivating this change

The running dashboard opens one persistent event stream per production line. Six lines consume the browser's six HTTP/1.1 connections per origin, causing ordinary API requests to queue. During diagnosis, direct server requests completed in approximately 2 ms while an API request from the dashboard timed out. The server itself was responsive.

## 2. Scope and constraints

### In scope

1. Shared stream endpoint and server-side connection management.
2. Frontend routing by line ID.
3. Initial state synchronization and reconnect behavior.
4. Live creation and deletion of lines.
5. Stream cleanup, heartbeat, and bounded backpressure handling.
6. Local HTTPS/HTTP/2 configuration.
7. Automated regression tests and browser verification.
8. Documentation and a safe rollout procedure.

### Out of scope

- Replacing SSE with WebSockets.
- Sharing one connection across multiple browser tabs.
- Rewriting orchestration or worker execution.
- Introducing a durable event store.
- Removing unrelated polling for plans, inventory, or evidence.
- Combining the separate registry protocol unless the dashboard actually consumes it.

### Existing changes to preserve

At planning time, the working tree contained changes in:

- `router-prototype/pipeline-config.js`
- `router-prototype/test/pipeline-config.test.js`
- Untracked `router-prototype/index.html`

Recheck the working tree before implementation and do not overwrite unrelated work. The actual served page is **`router-prototype/web/index.html`**.

## 3. Shared-stream protocol

### Endpoint

```http
GET /api/events
```

Response:

```http
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
```

These are application response headers. The browser-facing HTTP/2 response must not contain HTTP/1.1-only connection headers.

### Event envelope

Use one named SSE event, `dashboard`, containing a typed JSON envelope:

```text
event: dashboard
data: {"version":1,"type":"worker_status","lineId":"abc","data":{"workerId":"worker-1","status":"running"}}

```

Schema:

```js
{
  version: 1,
  type: string,
  lineId: string | null,
  data: object
}
```

Benefits:

- One frontend listener.
- Existing event payloads remain nested under `data`.
- Transport errors cannot be confused with application errors.
- Future event types do not require another connection.

### Event types

Preserve existing semantics:

- `state`
- `status`
- `entry`
- `worker_entry`
- `worker_spawned`
- `worker_status`
- `worker_removed`
- `validation_queue_cancelled`

Rename the existing application-level `error` to `line_error` on the shared wire protocol.

Add:

- `snapshot_begin`
- `snapshot_end`
- `line_created`
- `line_deleted`

Global synchronization events use `lineId: null`.

Unknown event types should be ignored safely, with a diagnostic warning rather than a broken dashboard.

## 4. Server-side stream hub

### Files

Add:

```text
router-prototype/dashboard-live.js
router-prototype/test/dashboard-live.test.js
```

Modify:

```text
router-prototype/server.js
```

### Responsibilities

The hub owns:

- One global collection of dashboard clients.
- SSE frame serialization.
- Client registration and removal.
- Broadcasting envelopes.
- Heartbeats.
- Backpressure limits.
- Stream shutdown.
- Connection-count logging.

Suggested interface:

```js
createDashboardLive({
  log,
  heartbeatMs,
  maxClients,
  maxBufferedBytes
})
```

Methods:

```js
attach(req, res, initialize)
publish(type, lineId, data)
close()
size()
```

Keep orchestration state outside this module. Pass snapshot generation into `attach`; the hub should not import the entire server.

### Replace per-line broadcasting

The current central function is:

```js
broadcast(line, event, data)
```

Retain it as the integration point, but publish through the global hub:

```js
dashboardLive.publish(
  event === "error" ? "line_error" : event,
  line.id,
  data
);
```

This avoids changing every producer individually.

Audit all producers, including events the current page does not handle, so none silently disappear.

### Connection ownership

New dashboard connections must not be stored in `line.clients`.

Deleting a line must never close the shared dashboard stream.

## 5. Initial state synchronization without races

Opening the stream must provide enough state to populate the dashboard without first opening per-line connections.

### Bootstrap sequence

```text
snapshot_begin   { lines: [line summaries...] }
state            lineId=A, full current state for A
state            lineId=B, full current state for B
...
snapshot_end
```

The frontend should:

1. Reconcile cards against the authoritative line catalog.
2. Create missing cards.
3. Remove cards absent from the catalog.
4. Apply each line's state.
5. Mark the dashboard synchronized at `snapshot_end`.

### Snapshot payload

Extract the existing per-line initial-state construction into a reusable function, for example:

```js
dashboardStateForLine(line)
```

Preserve:

- ID and name.
- Planner status.
- Session and started state.
- Pipeline configuration.
- Plan approval state.
- Worker metadata and completion fields.
- Changeset fields.
- Last errors.
- Recent transcript state.

Include bounded worker transcript tails as well as planner transcript tails, so reconnecting does not leave worker output inconsistent.

Use an explicit entry-count and byte budget. A single exceptionally large tool-output entry must not defeat the snapshot size bound.

### Ordering guarantee

Snapshot capture and initial publication must not contain asynchronous gaps that allow live deltas to arrive ahead of their baseline state.

For the current single-process server:

- Capture the snapshot synchronously.
- Register the client and enqueue bootstrap frames synchronously.
- Queue later publications after bootstrap frames.

Add a focused test for this ordering.

Do not perform disk reads, harness probes, or Git commands as part of stream attachment.

## 6. Reconnection

Use the browser's native `EventSource` reconnect mechanism. Do not create a replacement `EventSource` on every error.

### On disconnect

- Show a dashboard-level "Reconnecting…" indicator.
- Preserve displayed data.
- Do not show a transport failure as a planner failure.

### On reconnect

- Send a fresh authoritative snapshot.
- Replace snapshot-backed state rather than appending it.
- Reconcile created and deleted lines.
- Refresh selected-line auxiliary data where necessary.
- Clear the reconnect indicator only after `snapshot_end`.

### Delivery semantics

This patch provides snapshot-based recovery, not durable replay.

The existing prototype does not provide replayable IDs for these events. Do not add misleading SSE `id` values without a corresponding replay implementation.

`docs/adr/0003-sse-egress-gateway.md` describes durable replay for the broader architecture. Record that this prototype implementation uses bounded snapshots and does not yet implement that ADR's full event-store recovery contract.

Consequently:

- Current line and worker state recover after reconnect.
- Recent transcript tails recover.
- Arbitrarily long disconnected transcript history is not guaranteed by this change.

## 7. Frontend refactor

### Files

Modify:

```text
router-prototype/web/index.html
```

Add a small testable transport/dispatch module:

```text
router-prototype/web/dashboard-stream.js
router-prototype/test/dashboard-stream.test.js
```

Also update static asset serving and build validation for the new script.

### Separate card creation from transport

Currently `addCard()` both creates UI and opens a stream.

Change it so `addCard()` only:

- Creates DOM.
- Initializes card state.
- Registers line-specific event handlers.
- Registers the card in `cards`.
- Sets up existing controls and observers.

It must not construct an `EventSource`.

### Preserve existing handlers

Move the current listener bodies into a handler table associated with each card:

```js
st.handlers = {
  state(data) { /* existing state rendering */ },
  status(data) { /* existing status rendering */ },
  entry(data) { /* existing transcript update */ },
  worker_entry(data) { /* existing worker output update */ },
  // ...
};
```

The shared dispatcher does:

```js
const card = cards.get(envelope.lineId);
card?.handlers[envelope.type]?.(envelope.data);
```

Handle snapshot and line lifecycle events before line-specific dispatch.

### Create the connection once

At dashboard initialization:

```js
const stream = new EventSource("/api/events");
```

There should be exactly one construction path.

### Remove card-level connection cleanup

Remove `st.es` and `st.es.close()` from card lifecycle code.

`removeCard()` should continue cleaning up observers, DOM, selection, and pending card-specific work, but must not affect other lines' streaming.

### Preserve UI behavior

Regression-check:

- Selected line and worker.
- Preview selection.
- Planner and worker output.
- Follow-bottom scrolling.
- Error banners.
- Worker removal.
- Pipeline graphs.
- Approval controls.
- Process and evidence tabs.

## 8. Line creation and deletion

### Creation

After the line is successfully registered and saved:

```text
line_created { line summary }
state        { complete initial state }
```

All connected tabs should see the new line without waiting for polling.

The creation response and streamed event may arrive in either order, so card creation must be idempotent.

### Deletion

After removing the line from the authoritative in-memory collection:

```text
line_deleted { id }
```

Requirements:

- Other lines continue receiving events.
- Selected-line fallback still works.
- Repeated removal is harmless.
- Late worker callbacks for a deleted line do not recreate its card.
- Async preview responses cannot mutate removed cards.

### Polling interaction

Make the stream authoritative for the line catalog and live status.

Remove the recurring `/api/lines` catalog poll once snapshot and lifecycle tests pass. Keep that REST endpoint for CLI consumers and diagnostics.

Retain existing plan, inventory, and evidence polling for this patch, but ensure those polls do not create streams or overwrite authoritative catalog state.

## 9. Backpressure, cleanup, and observability

### Heartbeat

Send one comment heartbeat per client every 25 seconds:

```text
: ping

```

The heartbeat should be hub-level, not one timer per line.

### Slow clients

Handle `res.write()` returning `false`:

- Pause draining that client's application queue.
- Resume on `drain`.
- Count queued bytes, including bootstrap frames.
- Enforce a documented byte limit.
- Disconnect clients that exceed the limit so they reconnect and resynchronize.
- Never block healthy clients behind a slow client.

Define and test behavior for a single frame larger than the limit. Do not create an endless reconnect loop for a valid but oversized snapshot.

### Cleanup

Cleanup must be idempotent and handle:

- Request/response closure.
- Write errors.
- Slow-client eviction.
- Server shutdown.

Remove listeners and queue references on cleanup.

### Logs

Log:

- Stream open and close.
- Active dashboard client count.
- Bootstrap completion.
- Slow-client eviction.
- Serialization/write failures.

Avoid logging every transcript chunk or sensitive payload content.

## 10. HTTPS and HTTP/2 directly in Node

### Configuration

The router runs two listeners when HTTPS is enabled:

```text
PORT=7788                                  # existing HTTP/1.1 listener
HTTPS_PORT=7789                            # browser-facing TLS + HTTP/2 listener
TLS_KEY=/absolute/path/localhost-key.pem
TLS_CERT=/absolute/path/localhost-cert.pem
```

`node:http2.createSecureServer({ allowHTTP1: true }, requestHandler)` serves the
same routes from the TLS listener. `allowHTTP1` keeps browsers or tools that
cannot negotiate HTTP/2 compatible, while browsers that negotiate ALPN `h2`
use HTTP/2. No reverse proxy is part of the stack.

When `HTTPS_PORT` is unset or zero, the TLS listener is disabled and the
existing HTTP listener retains current behavior. If `HTTPS_PORT` is set without
both certificate paths, startup fails with a clear configuration error.

### TLS trust

Use a locally trusted development certificate (for example, generated with
`mkcert`) and pass its paths through `TLS_KEY` and `TLS_CERT`. Do not commit
certificate or private-key files, and do not rely on disabled certificate
verification as normal development setup.

Open `https://localhost:7789` after trusting the issuing local CA.

### HTTP/2 verification

Do not assume HTTPS means HTTP/2. Verify:

- ALPN selects `h2`.
- Browser DevTools reports `h2`.
- The SSE response arrives promptly from Node.
- Ordinary API requests complete while streaming remains active.

For deterministic transport tests, connect a real Node HTTP/2 client directly
to the TLS listener and assert its negotiated ALPN protocol is `h2`.

### Existing HTTP port

Keep `http://localhost:7788` working for worker instructions and tests. Do not
redirect worker protocol requests to HTTPS. The HTTPS listener is the preferred
browser entry point.

### HTTPS compatibility audit

Check the dashboard for:

- Hard-coded HTTP fetch URLs.
- Preview iframes.
- Evidence/media URLs.
- External scripts.
- Links versus embedded resources.

All dashboard-owned requests should remain same-origin. Explicitly test any HTTP worker preview embedded from the HTTPS dashboard; mixed-content restrictions must not silently break previews.

## 11. Compatibility strategy

Retain the old endpoint temporarily:

```text
GET /api/lines/:id/events
```

For one migration period:

- Existing consumers can continue using it.
- The new dashboard never calls it.
- Shared and legacy subscribers receive equivalent underlying updates.
- Legacy connections retain their existing payload format.

Keep legacy connection management separate from the new global hub.

Document the old endpoint as deprecated. Remove it in a later change after confirming there are no external consumers.

There must be no automatic frontend fallback to one stream per line, because that would reintroduce the original failure.

## 12. Test plan

### A. Stream hub unit tests

Cover:

- Envelope serialization and `lineId` preservation.
- Multiple clients and multiple lines.
- Bootstrap-before-delta ordering.
- Heartbeats.
- Disconnect cleanup.
- Idempotent cleanup.
- Backpressure and `drain`.
- Buffer-limit eviction.
- Oversized-frame policy.
- One failing client not breaking others.
- Complete shutdown.

### B. Frontend unit tests

Using a fake `EventSource`:

- Zero, one, six, and twenty lines all create exactly one connection.
- Each event reaches only its intended line.
- Worker events with identical worker IDs in different lines remain isolated.
- Snapshot reconciliation creates and removes cards correctly.
- Reconnect snapshots replace rather than duplicate output.
- Line removal does not close the shared connection.
- Native transport errors and `line_error` have different UI behavior.
- Malformed or unknown events do not break later valid events.
- Repeated initialization is prevented or cleans up the previous instance.

### C. Server integration tests

Run against an isolated server with a private `LINES_DIR`.

Verify:

- Endpoint headers.
- Bootstrap contents for multiple lines.
- Correctly tagged live events.
- Creation and deletion while connected.
- Reconnect after changes.
- Ordinary API requests remain responsive with the stream open.
- Legacy endpoint compatibility.
- Shutdown releases connections.

Use bounded reads and explicit stream cancellation; never await an SSE response body to completion.

### D. Actual HTTP/2 integration test

Run the Node router with an isolated TLS certificate, HTTPS port, and state directory.

Verify with a real HTTP/2 client:

- TLS/ALPN negotiation returns `h2`.
- One session carries SSE plus concurrent REST requests.
- Stream bytes are not buffered.
- Multiple dashboard clients do not break each other.
- TLS-listener interruption triggers recovery.
- Node restart triggers a fresh synchronized snapshot.

### E. Browser regression test

Seed at least twenty lines.

Verify:

1. Exactly one dashboard SSE request per tab.
2. Its negotiated protocol is `h2`.
3. API requests continue completing during streaming.
4. Repeated reloads do not hang.
5. Create/delete and line switching work.
6. Planner and worker output remain correctly routed.
7. Reconnect indicator clears after synchronization.
8. Evidence and preview behavior still works over HTTPS.

Also run the shared-stream regression over direct HTTP/1.1 to prove the application fix works independently of HTTP/2.

## 13. Implementation order

| Step | Deliverable |
| --- | --- |
| 1 | Protocol contract and recovery semantics |
| 2 | Tested server stream hub |
| 3 | `/api/events` endpoint and snapshot builder |
| 4 | Existing broadcasts routed through the hub |
| 5 | Shared frontend dispatcher and card refactor |
| 6 | Creation/deletion events and reconnect reconciliation |
| 7 | Remove redundant catalog polling |
| 8 | Node TLS/HTTP/2 configuration and certificate trust instructions |
| 9 | HTTP/2 integration and browser regression tests |
| 10 | Documentation, rollout, and legacy deprecation notes |

Each step should leave existing worker protocol behavior unchanged.

## 14. Rollout on the running instance

1. Implement and validate using a separate port and private state directory.
2. Run build validation and the full existing test suite.
3. Run the six-line and twenty-line browser regressions.
4. Confirm no active workers would be interrupted by restarting the real Node server.
5. Start and validate the Node TLS listener before switching the browser entry point.
6. Restart the real server only at an agreed safe point.
7. Open the HTTPS dashboard.
8. Confirm:
   - One stream.
   - HTTP/2 negotiation.
   - Responsive API requests.
   - Correct state for all existing lines.
9. Keep rollback instructions for the application code and TLS listener configuration.

**Do not restart the current instance merely to test the implementation.**

## Definition of done

The dashboard uses **one tagged SSE stream per tab over verified HTTP/2**, remains responsive with twenty or more lines, recovers current state after disconnects, and preserves existing worker, preview, and evidence workflows.
