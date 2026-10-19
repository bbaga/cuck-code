# ADR-0006: Build both orchestrator prototypes; start with Temporal

## Status

Accepted

## Context

Two viable architectures exist for the process manager:

- **A — Temporal OSS**: mature durable execution engine with native loops,
  signals, and replay. Costs: a dual history (its mechanics plus our domain
  audit store, required by ADR-0004), engine lock-in of state, an additional
  stateful service to operate, and audit bound to engine vocabulary if we
  relied on its history (we do not).
- **B — own event-driven process manager**: state machine over our event
  store; single history, engine-free state, full control. Costs: we build
  and own the engine — state machine, timers, versioned transitions, crash
  resume.

Analysis suggests the effort delta for milestone-1 scope is roughly one
engineer-week, which is smaller than the confidence gap between the two
camps. The decision hinges on hands-on evidence, not argument.

## Decision

Build **both prototypes over the shared facade** (adapters, event store,
outbox, SSE egress — identical in both) and record the final choice in
ADR-0007 after a side-by-side evaluation.

**Build order: Prototype A (Temporal) first**, Prototype B second,
reusing all shared components unchanged (target: zero diffs in shared
components when wiring B, verified by `git diff`).

Fairness and purity rules (enforced, not aspirational — see
[docs/prototype-plan.md](../prototype-plan.md)):

- Adapters write domain events only and never call the engine; engine
  inputs are fed by per-variant bridges that translate event-store facts
  into engine calls (A: StartWorkflow/signals; B: no bridge needed).
- Run identity is minted at the gateway, not by the engine.
- Both variants must pass the identical golden scenario (loop + approval
  gate + cancel) producing the identical event sequence, asserted by one
  e2e harness written from the event contract before either variant.
- Both variants undergo the identical failure-injection suite (crash
  mid-stage, duplicate delivery, cancel race, relay restart, timer).
- The verdict is scored against a rubric fixed before implementation;
  audit fit and replaceability are constraints, not tradeoffs.

## Consequences

- ~9–12 engineer-days to a defensible verdict on both variants; shared
  components survive either outcome.
- The bridge component is itself evidence: its size and friction in A
  measures exactly how much a dual-history, engine-fed design costs.
- Risk: prototype B can unconsciously inherit A's temporal-shaped
  assumptions (e.g., signal-like RPC). Mitigation: B's transition function
  consumes domain events only, and cancel is an event, not a call.
- The golden-scenario contract and failure suite must exist before variant
  implementation begins (Phase 0), or the comparison degrades to
  narrative.
