# Prototype Plan: Temporal as Process Manager

## Purpose

Evaluate Temporal OSS as the orchestration layer (process manager) of the
k8s-native software factory, behind our event facade. The prototype is an
evaluation vehicle, not the product: it must produce a go/no-go decision
backed by hands-on evidence.

The architectural constraint that shapes everything: Temporal may only occupy
the "process manager" box. Adapters, the domain event store, and the SSE
egress are identical to the own-build architecture, so none of that work is
wasted regardless of the verdict.

```
POST /v1/runs ──► api-gateway ──► Temporal: StartWorkflow(FactoryWorkflow)
                                        │
                                 ┌──────┴───────────────────────┐
                                 │ FactoryWorkflow (process mgr)│
                                 │  build → test → quality gate  │
                                 │      ▲          │fail, iter<N │
                                 │      └── rework ◄┘            │
                                 └──────┬───────────────────────┘
                                        │ activities
                        emitEvent (audit) ──► Postgres: event_log (+ outbox, same tx)
                                        │
                                  outbox relay
                                        │
                              sse-gateway ──► browser tracker page
```

## Evaluation criteria (what the prototype must answer)

1. **Loop ergonomics.** How naturally does the improvement loop (rework on
   quality-gate failure, bounded iterations) express in workflow code? How
   painful is changing workflow logic while runs are in flight (versioning)?
2. **Signals.** Cancel / re-prioritize a running run from outside. How clean
   is the signal path, and how does it map to our domain events?
3. **Dual-history cost.** We require our own domain event store for audit.
   How much friction does emitting domain events from activities add, and
   does the duplication feel manageable or accidental?
4. **Visibility vs. event tap.** Is Temporal query/visibility sufficient for
   the tracking page, or do we still end up serving the page from our event
   log? (Hypothesis: the latter — which weakens Temporal's value.)
5. **Ops weight.** Real cost of running Temporal server + its backing
   database beside our Postgres on k8s.

## Scope

### In
- Go worker + Temporal Go SDK, workflow `FactoryWorkflow`
- Improvement loop with `maxIterations`, quality gate stub
- Domain events appended to Postgres `event_log` from activities
  (append-only, transactional with outbox)
- API adapter: `POST /v1/runs`, `GET /v1/runs/{id}`
- SSE: `GET /v1/runs/{id}/events` — snapshot then deltas, `Last-Event-ID`
  reconnect, heartbeat frames
- Minimal tracker page (static HTML/JS, milestone updates)
- docker-compose for local dev; optional k8s manifests
- Evaluation writeup → go/no-go ADR

### Out (deferred)
- Knative Eventing (publisher port is a direct Postgres writer in this
  prototype; the port abstraction keeps the swap later)
- Slack / Jira adapters
- RBAC, multi-tenancy
- Real Tekton stages (stages are stub sleeps)
- Event schema versioning harness (payload version field exists, no
  migration machinery)
- Retention / partitioning of the event log

## Components

| Component | Responsibility |
|---|---|
| `api-gateway` | HTTP ingress adapter: trigger runs, map requests to workflow starts, expose SSE endpoint |
| `worker` | Temporal worker: workflow + activities (stages, quality gate, event emission) |
| `relay` | Outbox relay: publishes pending events (in prototype: Postgres LISTEN/NOTIFY to SSE gateway) |
| `sse-gateway` | Serves per-run SSE streams; snapshot from projection, deltas from relay |
| Postgres | `event_log`, `outbox`, `run_projection` |
| Temporal server | Workflow engine (dev: docker-compose with its own DB) |

## Event envelope (first cut, CloudEvents-conformant)

```
type, source, id, time, subject,
correlationid (workflow run), causationid (parent event, if any),
iteration, actor, payloadversion, payload
```

Domain events for milestone 1: `WorkflowRequested`, `StageStarted`,
`StageCompleted`, `QualityGateEvaluated`, `ReworkRequested`,
`WorkflowCompleted`, `WorkflowFailed`, `WorkflowCancelled`.

## Phases

| Phase | Deliverable | Est. |
|---|---|---|
| 0 | Repo scaffold, docker-compose (temporal, postgres), Makefile | 0.5d |
| 1 | Workflow with loop, stub stages, cancel signal, visible in Temporal UI | 1–2d |
| 2 | Domain event emission: `emitEvent` activity, event_log + outbox tx | 1d |
| 3 | API adapter, SSE gateway, tracker page (snapshot + deltas + reconnect) | 2d |
| 4 | k8s deployment (Temporal helm chart, our services) | 1–2d, optional for verdict |
| 5 | Evaluation writeup against criteria, go/no-go ADR | 0.5d |

Total: ~5–7 days to a defensible verdict.

## Watchouts

- Workflow code determinism: no `time.Now()`, no random, no direct I/O — all
  the classic first-week gotchas. Side effects only in activities.
- History growth on long loops: keep iterations bounded in the prototype.
- Do not build the tracker page on Temporal's query API — the point is to
  validate the event-driven egress design; query is only a comparison
  datapoint.
- SSE through proxies: disable response buffering, heartbeat every 15–30s.
- Append-only enforcement on `event_log`: app role gets INSERT/SELECT only.

## Decisions still open (not blocking Phase 0)

- Language confirmed as Go (assumption; temporal-go-sdk is the most mature).
- Real quality-gate policy shape (prototype uses a stub with a seeded pass/fail).
- Whether Phase 4 (k8s) is required for the verdict or docker-compose suffices.
