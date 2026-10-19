# ADR-0004: Domain event store is the source of truth and the audit log

## Status

Accepted

## Context

Audit requirements are strict: immutable, queryable, tamper-evident records
of what happened, who triggered it, and why decisions were made — retained
long-term. etcd/CRD history is capped (~10 revisions) and is not a real
audit home. An external workflow engine's history (e.g., Temporal's)
records engine mechanics in the engine's vocabulary, is per-execution and
size-capped, and would bind the organization's audit record to that engine
for as long as retention requires.

## Decision

A single Postgres-backed **append-only domain event store** is the source of
truth and the audit log. Operational state is derived from it (fold/replay);
projections for serving (SSE snapshots) and for k8s visibility (a
`WorkflowRun` CRD as a projection/mirror) are consumer-built and never
written authoritatively.

- `event_log`: append-only; the application role holds INSERT/SELECT grants
  only; trigger-based rejection of mutations; hash-chaining of rows if
  tamper evidence is required.
- `outbox`: written in the same transaction as the event; the relay
  publishes downstream (ADR-0002).
- Events record domain facts (`QualityGateEvaluated`, `ReworkRequested`)
  with actor and causation, not engine mechanics.
- Event schema versioning is mandatory from day one (history cannot be
  migrated retroactively); the store is partitioned by time from the start.

## Consequences

- The transactional outbox gives at-least-once publishing with no crash
  window.
- One history per organization, independent of any engine — this is the
  primary hedge that keeps the orchestrator replaceable (ADR-0006).
- Engine history (if Temporal is chosen) is disposable mechanics, never
  audit.
- Costs: schema governance, retention/archival policy, partitioning, and
  replay tooling are ongoing obligations.
