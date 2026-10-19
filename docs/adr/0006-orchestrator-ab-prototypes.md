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
components when wiring B).

Evaluation criteria and phase plan are defined in
[docs/prototype-plan.md](../prototype-plan.md) and fixed before build, so
neither prototype is graded by the rules of the other.

## Consequences

- ~8–11 engineer-days to a defensible verdict on both variants; shared
  components survive either outcome.
- The facade (ADR-0002 publisher port, ADR-0004 event store, ADR-0003 SSE
  egress) becomes a proven artifact in itself: whichever engine loses, the
  demonstration that the process manager is swappable is worth the extra
  week.
- Risk: prototype B can unconsciously inherit A's temporal-shaped
  assumptions (e.g., signal-like RPC). Mitigation: B's transition function
  consumes domain events only, and cancel is an event, not a call.
