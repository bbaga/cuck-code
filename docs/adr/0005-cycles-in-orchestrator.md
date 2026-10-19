# ADR-0005: Cycles live in the orchestrator; executors stay acyclic

## Status

Accepted

## Context

The factory needs improvement loops: redirect flow back to earlier stages
when a quality gate fails. Pipeline executors are deliberately acyclic —
Tekton Pipelines are a DAG by definition and reject cycles and recursive
pipeline references; Argo Workflows only simulates loops via self-referencing
templates. Encoding loop state inside an executor buries the loop condition
in YAML and loses the domain-event trail.

## Decision

The orchestrator (process manager) owns all cycles. Executors execute
bounded acyclic graphs only.

- Each loop iteration is a **new executor run** stamped with
  `{correlationId: run, iteration: N}` in the event metadata.
- Loop conditions (`until: qualityGatePassed`, guards like `maxIterations`,
  budgets, backoff) are domain logic in the orchestrator.
- Every iteration is a first-class auditable run: visible as iteration
  history on the tracking page, queryable, independently retryable.

## Consequences

- Executors remain replaceable (Tekton ↔ Argo ↔ stub) without touching loop
  semantics.
- Loop guards and policies are ordinary code and events, enforceable and
  auditable.
- In Prototype B, loops are rows in the transition table. In Prototype A
  (Temporal), loops are workflow code — one of the evaluation criteria
  (ADR-0006) is how naturally that expresses and how it versions.
