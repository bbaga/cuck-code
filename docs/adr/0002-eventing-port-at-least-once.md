# ADR-0002: Eventing behind a port, at-least-once delivery

## Status

Accepted

## Context

The factory must react to stimuli and communicate results across adapters
and services. Knative Eventing is the leading candidate for the eventing
backbone, but it must remain replaceable. Consumers run on k8s where crashes
and reschedules are normal, so events must not be lost.

## Decision

Domain code depends on two ports only: `EventPublisher.publish(event)` and a
typed `EventSubscription` with explicit acknowledgement. No domain or
orchestrator code imports broker types. Knative Eventing is the first
infrastructure implementation of the port and may be swapped without domain
changes.

Delivery semantics are **at-least-once**, which is a consumer contract:

- every event has a stable `id`; consumers deduplicate on it,
- consumers are idempotent: handlers reconcile toward desired state rather
  than applying deltas,
- ordering is not trusted; consumers use `correlationid` plus per-run
  sequence/version to reject stale transitions.

Publishing follows the transactional outbox pattern: events are written to
the outbox in the same transaction as the state change; a relay publishes
them. This closes the crash window between state write and publish.

## Consequences

- Broker choice becomes an infrastructure concern, decoupled from the
  domain and from the A/B orchestrator decision.
- Duplicate delivery must be assumed and tested for in every consumer.
- In the prototypes the publisher port is a direct Postgres writer and the
  relay uses LISTEN/NOTIFY; Knative Eventing integration is deferred.
