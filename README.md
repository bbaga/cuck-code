# cuck-code

A Kubernetes-native software factory. Orchestration layer reacting to stimuli
(API, Jira, Slack) translated by adapters into domain events, with two-way
communication keeping users informed about what happens inside the system.

Status: prototype phase — building both orchestrator variants (A: Temporal,
B: own process manager) over a shared event facade; Temporal first.
See [docs/prototype-plan.md](docs/prototype-plan.md) and
[docs/adr/](docs/adr/).

## Setup

Run `npm ci` in `router-prototype/` before you start the router or run the tests.
