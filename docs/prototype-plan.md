# Prototype Plan: Orchestrator A/B — Temporal vs. Own Process Manager

## Purpose

Decide the orchestration layer of the k8s-native software factory on
evidence, not argument: build **two prototypes of the process manager** over
a shared facade, evaluate them side by side with a fixed rubric, and record
the verdict in ADR-0007.

**Build order: Prototype A (Temporal) first**, then Prototype B (own
event-driven process manager), reusing everything around the process manager
unchanged.

```
                     Shared (must be identical, verified by e2e + diff)
 ────────────────────────────────────────────────────────────────────────
 POST /v1/runs ──► api-gateway ──► Postgres event_log (+ outbox, same tx)
 POST /v1/runs/{id}/approval          │
                                      │ (bridge consumes events,
                                      │  feeds engine)      ┌ variant code
                                      ▼                     ▼
                             A: bridge → StartWorkflow / Signal
                             B: process manager consumes directly
                                      │
 GET /v1/runs/{id}/events ◄── sse-gateway ◄── relay ◄── outbox
                        │
                 projection-builder ──► run_projection (snapshots)
                        │
                 browser tracker page
```

## Facade purity rules (non-negotiable)

These rules are what makes the comparison honest and the facade real. They
apply to both variants.

1. **Adapters write domain events only.** The api-gateway appends
   `WorkflowRequested` / `WorkflowCancelled` / `ApprovalGranted` to the
   event store and returns. It never calls the engine. Consequence: the
   gateway is byte-identical across variants and the audit trail always
   contains the trigger.
2. **Engine inputs come from bridges.** Each variant ships a small
   `bridge` component that consumes event-store facts and translates them
   into engine inputs (A: `StartWorkflow`, signals; B: the process manager
   consumes events directly, so the bridge is a no-op). This keeps engine
   vocabulary out of adapters while allowing A to be event-fed.
3. **The run id is minted at the gateway** (UUID). In A it doubles as the
   Temporal workflow id; everywhere it is `correlationid`. No engine
   generates identity.
4. **The tracker page consumes domain events only** — never Temporal
   query, never controller APIs. Temporal UI is a comparison datapoint,
   not a component.
5. **Both variants must pass the identical golden scenario producing the
   identical event sequence**, asserted by a shared e2e harness
   (`make e2e VARIANT=a|b`). The harness is written once, before the
   variants, from the event contract below.

Rule 2 makes the real difference between the variants measurable: A pays a
bridge, B does not. If the bridge in A feels accidental-complexity-free and
small, that is evidence for A; if it grows, that is evidence for B.

## Golden scenario (fixed, shared)

A single parameterized run exercises everything under evaluation:

1. `POST /v1/runs {repo, iterations_to_pass: 1, approval: granted}` —
   quality gate stub fails on iteration 1, passes on iteration ≥ 2
   (parameterized, deterministic)
2. build → test → `QualityGateEvaluated(fail)` → `ReworkRequested` →
   build → test → `QualityGateEvaluated(pass)`
3. **Approval gate** (human-in-the-loop): `ApprovalRequested` emitted; run
   waits for `ApprovalGranted` (posted via the gateway) or times out after
   60s. Exercises signals *and* timers in both variants.
4. `WorkflowCompleted`

Expected event sequence (the e2e contract, `iterations_to_pass=1`):

```
WorkflowRequested
StageStarted(build, iter 1)      StageCompleted(build, iter 1)
StageStarted(test, iter 1)       StageCompleted(test, iter 1)
QualityGateEvaluated(iter 1, fail)
ReworkRequested(iter 1 → 2)
StageStarted(build, iter 2)      StageCompleted(build, iter 2)
StageStarted(test, iter 2)       StageCompleted(test, iter 2)
QualityGateEvaluated(iter 2, pass)
ApprovalRequested
ApprovalGranted
WorkflowCompleted
```

Variations run by the same harness: approval timeout path (no grant →
escalation/failure after 60s), cancel mid-run, `iterations_to_pass: 2`.

## Evaluation rubric (fixed before build)

Each criterion scored 1–5 per variant, every score citing evidence (phase
log entry, commit, test run). Constraints must pass or the variant is out.

| # | Criterion | Weight | Kind |
|---|---|---|---|
| 1 | Loop + approval ergonomics, versioning pain | 20% | tradeoff |
| 2 | Signal path naturalness (cancel/approval as events) | 15% | tradeoff |
| 3 | Audit fit (dual history vs. single) | 20% | **constraint: A must score ≥3** |
| 4 | Visibility vs. event tap (does engine query add value?) | 5% | tradeoff |
| 5 | Ops weight on k8s | 15% | tradeoff |
| 6 | Replaceability estimate in year two | 15% | tradeoff |
| 7 | Measured implementation effort | 10% | tradeoff |

Verdict: weighted sum, but criteria 3 and 6 dominate — a variant cannot win
by ergonomics what it loses in audit and lock-in. ADR-0007 must contain the
filled matrix with evidence links.

## Scope

### Shared, built once (identical for A and B — verified by diff)
- `api-gateway` (trigger, approval, cancel; appends events, mints run ids)
- `relay` (outbox → LISTEN/NOTIFY fan-out), `sse-gateway` (snapshot +
  deltas, `Last-Event-ID`, heartbeats), `projection-builder`, tracker page
- Postgres DDL: `event_log` (append-only, `(run_id, seq)` unique — `seq`
  gives SSE replay ordering), `outbox`, `run_projection`, `waiting_for` (B)
- e2e harness asserting the event contract above
- docker-compose: postgres + temporal dev server (`temporal server
  start-dev` locally; full server + own DB deferred to k8s phase)

### Variant A (Temporal) — built first
- `worker`: workflow `FactoryWorkflow` (loop, approval wait via
  signal + timer, cancel signal), activities: stub stages, quality gate
  stub, `emitEvent` (event_log + outbox tx)
- `bridge`: `WorkflowRequested` → StartWorkflow; `ApprovalGranted` /
  `WorkflowCancelled` → signals

### Variant B (own process manager)
- process manager: consume event → load run state (fold) → transition
  table → write events + outbox atomically; loop, cancel, approval are
  transition-table rows
- timers: `waiting_for` table + scanner (CronJob or long-poll)
- bridge: none (consumes directly)

### Out (both variants)
- Knative Eventing (publisher port writes Postgres directly — ADR-0002)
- Slack / Jira adapters, RBAC, multi-tenancy
- Real Tekton stages (stub sleeps)
- Event schema migration machinery (payload version fields only)
- Retention / partitioning of the event log

## Phases, with acceptance criteria

| Phase | Deliverable | Accept when | Est. |
|---|---|---|---|
| 0 | Scaffold, DDL, docker-compose, e2e harness skeleton (contract test, red) | `make e2e` runs and fails on empty impl | 1d |
| A1 | Temporal worker: golden scenario incl. loop, approval, cancel | golden run visible in Temporal UI; cancel mid-run halts | 1–2d |
| A2 | Event emission from activities | event_log holds the exact contract sequence; outbox drains | 1d |
| A3 | Shared stack wired: gateway, bridge, relay, sse, projection, page | `make e2e VARIANT=a` green; SSE survives reconnect with replay | 1.5d |
| A4 | A-specific failure + change exercises (below); log observations | matrix evidence recorded | 1d |
| B1 | Process manager: transition table incl. loop, approval, cancel | `make e2e VARIANT=b` green against the same contract | 2d |
| B2 | Timer service, failure exercises; log observations | `make e2e VARIANT=b` green incl. timeout variation | 1d |
| B3 | Purity audit: `git diff` on shared dirs = empty when switching variant | diff verified clean | 0.5d |
| C | Rubric scored with evidence → ADR-0007 | ADR-0007 merged | 1d |

Total: ~9–12 days.

## Failure-injection suite (identical for both variants)

1. `kill -9` the worker / process manager mid-stage → restart → run
   completes, no duplicate events (event ids unique in `event_log`).
2. Re-deliver a duplicate event to B (and to the relay) → no double
   transition; SSE clients see no duplication.
3. Cancel races with stage completion → per-run serialization holds; one
   coherent outcome (`WorkflowCancelled` or iteration advances, never both).
4. Relay restart with pending outbox rows → all events published, SSE
   replay has no gaps.
5. Approval timeout with page connected → escalation event reaches SSE.

## Mid-run change exercise (criterion 1 evidence)

While a run is in flight, change quality-gate behavior
(`iterations_to_pass` 1 → 2) and deploy, in both variants. Record: what
happens to in-flight runs, what the author had to do, how versioning is
expressed. This is the single most expensive surprise in both approaches;
measure it rather than guess.

## Measured effort log (criterion 7 — fill as work happens)

| Phase | Planned | Actual | Notes |
|---|---|---|---|
| 0 | 1d | | |
| A1 | 1–2d | | |
| A2 | 1d | | |
| A3 | 1.5d | | |
| A4 | 1d | | |
| B1 | 2d | | |
| B2 | 1d | | |
| B3 | 0.5d | | |
| C | 1d | | |

## Watchouts

- Temporal workflow determinism: no `time.Now()`, no random, no direct I/O
  in workflow code — side effects only in activities.
- Keep B's transition function honest: no hidden state outside the event
  store, or crash-resume is no longer free; per-run events must be
  processed serially (ordering + race safety).
- History growth on loops: keep iterations bounded in the prototypes.
- Do not strengthen either variant with features the other lacks — the
  shared contract is the equalizer; extensions go through the contract.
- SSE through proxies: disable response buffering, heartbeats 15–30s.
- Append-only enforcement on `event_log`: app role gets INSERT/SELECT only.
- Pin the Temporal server and SDK versions; record them in the ADR-0007
  evidence.

## Decisions still open (not blocking Phase 0)

- Go confirmed as the implementation language (assumption).
- Whether the k8s deployment (Temporal helm chart, criterion 5) is required
  for the verdict or the dev server + ops estimate suffices.
- Retention/partitioning design (explicitly deferred, must not leak into
  prototype schema decisions badly — `seq` per run chosen to keep options
  open).
