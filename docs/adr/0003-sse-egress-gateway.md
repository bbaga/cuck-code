# ADR-0003: SSE live tracking as an egress adapter

## Status

Accepted

## Context

Users must know what is happening inside the factory (two-way
communication). Milestone 1 requires a streaming live tracking page. The
page must survive reconnects and serve correct history for any run without
sticky routing.

## Decision

Live tracking is served over **SSE** and treated as just another egress
adapter consuming domain events — not a special channel:

- endpoint: `GET /v1/runs/{id}/events`
- on connect: send a state snapshot from the projection/read model, then
  stream deltas sourced from the event log
- reconnect: honor `Last-Event-ID`, replay events after that id
- heartbeat comment frames every 15–30s
- proxies must have response buffering disabled; any gateway replica can
  serve any run because state is recoverable from the projection store
  (no sticky sessions)

The page never queries the orchestration engine directly (Temporal query,
controller APIs); it consumes domain events only.

## Consequences

- The tracking stream is a filtered tap on the event log; replay semantics
  come for free and the same pattern serves future channels (Slack, Jira).
- A projection store (`run_projection`) is required, built by consuming the
  same events.
- SSE-through-proxy configuration is an early integration test, not a
  late discovery.
