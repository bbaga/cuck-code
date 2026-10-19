# ADR-0001: CloudEvents-conformant domain event envelope

## Status

Accepted

## Context

Stimuli arrive through multiple adapters (REST, Jira, Slack) and must be
translated into a single internal representation the orchestrator and all
consumers understand. The eventing transport must be replaceable (ADR-0002).
Different buses (Knative Eventing, Kafka, NATS) speak different native
formats but all support CloudEvents.

## Decision

All domain events use a CloudEvents 1.0-conformant envelope. The envelope
carries: `type`, `source`, `id`, `time`, `subject`, `correlationid`
(workflow run), `causationid` (parent event, if any), `iteration`, `actor`,
`payloadversion`, `payload`.

Payload schemas are defined separately from the envelope and versioned via
`payloadversion`. Consumers must tolerate unknown attributes; envelope
changes must be additive.

## Consequences

- Bus replacement is reduced to infrastructure configuration, because the
  wire format is already the interchange standard.
- Distinguishes commands (intent, may be rejected) from events (fact) by
  `type` naming convention; the envelope itself is neutral.
- `correlationid` + per-run sequence enables ordering and staleness checks
  under at-least-once delivery without trusting bus ordering.
- Payload schema governance becomes a first-class process from day one.
