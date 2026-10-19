# Prototype Plan: Orchestrator A/B — Temporal vs. Own Process Manager

## Purpose

Decide the orchestration layer of the k8s-native software factory on
evidence, not argument: build **two prototypes of the process manager** over
a shared facade, evaluate them side by side, and record the verdict in a
final ADR (0007).

**Build order: Prototype A (Temporal) first**, then Prototype B (own
event-driven process manager), reusing everything around the process manager
unchanged.

The architectural constraint that makes this affordable: the process manager
is the *only* box that differs. Adapters, the domain event store, the outbox,
and the SSE egress are identical in both prototypes — that work is invested
once and survives the verdict either way.

```
                 Shared (identical in A and B)
 ─────────────────────────────────────────────────────────────
 POST /v1/runs ──► api-gateway ──► process manager ──► Postgres
                                        │            event_log (+outbox)
                                        │                  │
 GET /v1/runs/{id}/events ◄── sse-gateway ◄── relay ◄──────┘
                                        │
                                 browser tracker page

                 Variant
 ─────────────────────────────────────────────────────────────
 A: Temporal worker (workflow code, activities, signals)
 B: own process manager (state machine consuming domain events,
    transition table, timers)
```

## Evaluation criteria (both prototypes scored against these)

1. **Loop ergonomics.** Improvement loop (rework on quality-gate failure,
   bounded iterations): how naturally does it express? How painful is
   changing logic while runs are in flight?
2. **Signals.** Cancel / re-prioritize a running run from outside. How does
   the signal path map onto our domain events?
3. **Audit fit.** Cost of maintaining our domain event store alongside:
   A pays a dual history (Temporal's + ours) by design; B has one history.
   Measure how accidental or manageable the duplication feels in A.
4. **Visibility vs. event tap.** Is the engine's query/visibility sufficient
   for the tracking page, or do we serve the page from our event log
   regardless? (Hypothesis: the latter — then Temporal's visibility adds no
   unique value.)
5. **Ops weight.** Real cost of running the variant on k8s: A = Temporal
   server + its backing DB beside our Postgres; B = one more Go service.
6. **Replaceability.** Effort estimate to swap the engine out in year two,
   given the facade.
7. **Implementation cost.** Actual engineer-days, measured, not estimated.

## Scope

### Shared, built once
- Go services: `api-gateway`, `relay`, `sse-gateway`, tracker page
- Postgres: `event_log` (append-only), `outbox`, `run_projection`
- Event envelope (CloudEvents-conformant, see ADR-0001) and the eight
  milestone-1 domain events
- docker-compose for local dev; k8s manifests optional

### Prototype A (Temporal) — first
- Temporal server (own DB) via docker-compose
- Worker: workflow `FactoryWorkflow` with improvement loop, activities:
  stub stages, quality gate, `emitEvent` (audit + outbox tx)
- Cancel via Temporal signal
- Temporal UI as a comparison datapoint (not the tracker page)

### Prototype B (own process manager)
- Event-driven state machine per run: consume event → load state →
  transition function → write new events + outbox atomically
- Timers via a `waiting_for` table + scanner (CronJob or long-poll loop)
- Cancel is just a domain event the transition function handles
- Crash resume free: state = fold of event log; dedup by event id
- Iteration/loop logic in the transition table, executors stay acyclic
  (ADR-0005)

### Out (both prototypes)
- Knative Eventing (publisher port is a direct Postgres writer; the port
  keeps the swap cheap — ADR-0002)
- Slack / Jira adapters, RBAC, multi-tenancy
- Real Tekton stages (stub sleeps)
- Event schema migration machinery (payload version fields only)
- Retention / partitioning of the event log

## Event envelope (first cut, CloudEvents-conformant)

```
type, source, id, time, subject,
correlationid (workflow run), causationid (parent event, if any),
iteration, actor, payloadversion, payload
```

Domain events: `WorkflowRequested`, `StageStarted`, `StageCompleted`,
`QualityGateEvaluated`, `ReworkRequested`, `WorkflowCompleted`,
`WorkflowFailed`, `WorkflowCancelled`.

## Phases

| Phase | Deliverable | Est. |
|---|---|---|
| 0 | Shared scaffold: repo layout, docker-compose (postgres [+ temporal]), Makefile | 0.5d |
| A1 | Temporal worker: workflow with loop, stub stages, cancel signal, Temporal UI | 1–2d |
| A2 | Domain event emission from activities (event_log + outbox tx) | 1d |
| A3 | api-gateway, relay, sse-gateway, tracker page wired to Temporal run | 2d |
| B1 | Process manager: state machine, transition table, loop + cancel as events | 2d |
| B2 | Timer service + crash-resume/idempotency tests | 1d |
| B3 | Wiring reuses A3 components unchanged (target: zero diffs) | 0.5d |
| C | Side-by-side evaluation matrix, verdict → ADR-0007 | 1d |

Total: ~8–11 days to a defensible verdict on both variants.

## Watchouts

- Temporal workflow determinism: no `time.Now()`, no random, no direct I/O
  in workflow code — side effects only in activities.
- Do not build the tracker page on Temporal's query API in A: the point is
  to validate the event-driven egress; query is only a comparison datapoint.
- Keep B's transition function honest: no hidden state outside the event
  store, or crash-resume is no longer free.
- SSE through proxies: disable response buffering, heartbeat every 15–30s.
- Append-only enforcement on `event_log`: app role gets INSERT/SELECT only.
- Measure implementation cost honestly per phase — criterion 7 needs real
  numbers, and B starts with A's shared components already built.

## Decisions still open (not blocking Phase 0)

- Language confirmed as Go (assumption; temporal-go-sdk most mature).
- Quality-gate policy shape (seeded stub pass/fail in both prototypes).
- Whether k8s deployment is required for the verdict or docker-compose
  suffices (criterion 5 then stays partially theoretical).
