# Pipeline graphs, node types and interactions (design proposal)

Status: proposal, not implemented.

## Goal

Today the pipeline shape is code: four fixed phases (`planner`,
`implementor`, `validator`, `integration`), prompts built by functions in
`server.js`, and a fixed route for each interaction. This proposal moves the
shape into files:

- A **pipeline file** defines the nodes, the one start node, and which
  interactions each node may have with which other node.
- A **node type** defines a node's role and system prompt.
- An **interaction** defines one kind of communication: what it does, which
  values the caller must supply, and the message it delivers.

Node types and interactions ship as built-in files. Users add their own as
plugins, in the same way as agent skills: a folder with a markdown file.

Code keeps only what the router must execute: two effects, two triggers,
four target rules, the workspace kinds, and the validation rules.

## Concepts

| Term | Meaning |
|---|---|
| Node type | A reusable role: prompt plus runtime behaviour. Example: `validator`. |
| Node | One use of a type in a pipeline, with its own id and settings. Example: `security-review` of type `validator`. |
| Instance | One running agent of a node. A node can have many: `impl-login`, `impl-login-2`. |
| Interaction | A kind of communication, such as `start`, `feedback` or `report`. |
| Edge | Permission for one node to use one or more interactions toward another node. |

The graph is between nodes. Instances are created at run time, and the
router checks every interaction between instances against the edges between
their nodes.

## Pipeline file

```yaml
# pipelines/review-gate.yaml
name: review-gate
description: Implement, then a security review that can reject the work.
start: planner

nodes:
  planner: { type: planner }
  A:       { type: implementor, harness: vibe, model: glm-5-3-flash }
  B:       { type: security-reviewer }        # a plugin type

edges:
  - planner -> A: start, feedback   # start A, start a fresh A2, or give A feedback
  - A -> planner: report
  - planner -> B: start             # the planner starts B on A's work (source = the A instance)
  - B -> planner: report            # B passes or rejects; the planner decides
```

The syntax of an edge is `<from> -> <to>: <interaction>[, <interaction>...]`.
Either side can be a list, `[a, b]`, and the edge then applies to every pair.
The names after the colon are interaction names, and nothing more: the
meaning of each name is in its interaction file.

The run settings on a node (`harness`, `model`, `effort`, `timeLimit`,
`maxContext`) replace today's per-phase settings.

### Prompt extensions

A node's system prompt can be extended in the pipeline file itself, with no
separate type or interaction file. `defaults.prompt` applies to every node.
A node's `prompt` is added after it:

```yaml
defaults:
  prompt: |
    The product is a payments service. Never log card numbers or tokens.

nodes:
  A:
    type: implementor
    prompt: |
      Follow the error-handling rules in docs/errors.md.
      Every new endpoint needs an OpenAPI entry.
  B:
    type: security-reviewer
    prompt:
      file: prompts/pci-checks.md        # relative to the pipeline file
    fields:                              # declares this node's own caller placeholders
      riskLevel:
        description: The risk level of the change, from the planner's assessment.
        type: enum
        values: [low, medium, high]
```

- `prompt` is either inline text or `{ file: <path> }`. The file must stay
  inside the pipeline file's folder.
- An extension is a template like any other. Router variables work. A
  caller placeholder, such as `{{riskLevel}}` in `pci-checks.md`, must be
  declared under the node's `fields`. It then becomes a required field of
  every `start` of that node.
- An extension adds text only. It cannot change the type's runtime
  behaviour, and it cannot remove the router rules.

## Interactions

An interaction is a folder with an `INTERACTION.md`. The frontmatter declares
what the interaction does and the values it needs. The body is the message
template.

```markdown
---
name: feedback
description: Send follow-up instructions to an existing instance. It resumes its session.
effect: deliver        # create | deliver
trigger: request       # request | complete
target: chosen         # new | chosen | starter | source
fields:
  instructions:
    description: The corrected or additional instructions, written for the instance.
    type: text
    maxLength: 20000
---
Follow-up instructions from {{from.node}} (ASD-STE100):
{{instructions}}

When done, reply with a report: what you changed, files changed, how you
verified it, open issues. That report goes to {{from.node}} verbatim.
```

The building blocks the router implements:

| Field | Values |
|---|---|
| `effect` | `create`: a new instance of the target node; the message is its first turn. `deliver`: the message goes into an existing instance's conversation and wakes it. `accept`: reserved for the built-in `accept` interaction. |
| `trigger` | `request`: the sender calls the router API. `complete`: the router acts when a run of the sender ends. |
| `target` | `new`: the instance this call creates (only with `create`). `chosen`: an instance the caller names. `starter`: the instance that created the sender. `source`: the instance whose work the sender checks. |

### Built-in interactions

| Name | effect | trigger | target | Caller fields |
|---|---|---|---|---|
| `start` | create | request | new | `task`, plus whatever the target type needs (see below) |
| `feedback` | deliver | request | chosen | `instance`, `instructions` |
| `report` | deliver | complete | starter | none: the router fills `report` and `outcome` |
| `accept` | accept | request | chosen | `instance`, `reason`. Records that the coordinator accepts the instance's latest run without a check. This replaces `SKIP VALIDATION`. |

The `accept` effect is reserved for the built-in `accept` interaction. It
sends no message: it records the acceptance, which the integration rule uses.

## Strict calls

The router rejects any request-triggered call that does not supply exactly
the values it needs. No message reaches an agent with an unfilled
placeholder.

### Which fields a call requires

The **required fields** of a call are the union of:

1. The caller placeholders in the interaction's message template.
2. For `effect: create`: the caller placeholders in everything the new
   instance's prompt is built from. That means the target node type's
   `NODE.md`, its `extends` parents, and the prompt extensions in the
   pipeline file (`defaults.prompt` and the node's `prompt`).
3. The fields the effect needs:
   - `instance` for target `chosen`.
   - `repo` (and the optional `base`) when the target type's workspace is
     `own-worktree`.
   - `source` when it is `source`.

A **caller placeholder** is any `{{name}}` that is not a router variable.
Router variables are filled by the router and are never accepted from the
caller: `line.*`, `node.*`, `instance.*`, `from.*`, `repo.url`, `router.url`,
`source.name`, `source.report`, `report`, `outcome`. A call that supplies one
of them is rejected.

### Field declarations

Every caller placeholder must have an entry under `fields`, in the
interaction, node type or pipeline node that uses it. A placeholder without an entry
fails loading. The entry carries what the error messages and the generated
API documentation show:

```yaml
fields:
  criteria:
    description: Numbered acceptance criteria, one check per line, in the imperative.
    type: text            # string (one line) | text | enum | commit | instance | repo
    maxLength: 8000
  trackerTicket:
    description: Ticket id that every branch name must start with.
    type: string
    pattern: "^[A-Z]+-[0-9]+$"
    optional: true        # used only inside {{#trackerTicket}}...{{/trackerTicket}}
```

A field is required and must be non-empty, unless it is `optional: true`. An
optional field may appear only inside a section for that field. Loading fails
otherwise, so an optional value can never leave a hole in a prompt.

`type: instance`, `type: repo` and `type: commit` are checked against the
line state. The instance must exist, belong to the right node, and not be
running; the repo must be registered; the commit must exist.

### The error a caller gets

A call with missing, invalid or unexpected fields gets a 400. The response
lists every problem at once, with each field's description, so the caller can
fix everything in one retry:

```json
{
  "error": "start of node 'B' is incomplete: fill every listed field",
  "code": "INTERACTION_FIELDS",
  "interaction": "start",
  "to": "B",
  "missing": [
    { "field": "criteria", "description": "Numbered acceptance criteria, one check per line, in the imperative.", "requiredBy": "node type security-reviewer" },
    { "field": "source", "description": "The instance whose work B checks.", "requiredBy": "workspace: source" }
  ],
  "invalid": [
    { "field": "task", "reason": "longer than 20000 characters" }
  ],
  "unexpected": ["persona", "report"],
  "expected": {
    "task": "text, required",
    "criteria": "text, required",
    "source": "instance of A, required",
    "trackerTicket": "string ^[A-Z]+-[0-9]+$, optional"
  }
}
```

A call is also rejected (403, `NO_EDGE`) when no edge allows that interaction
between the caller's node and the target. The error lists what the caller
may do instead.

### Introspection and prompts

`GET /api/protocol/lines/:id/interactions` returns the interactions the
caller may use, per target node, with the full field list. The coordinator's
protocol section is generated from the same data. The fields the prompt
documents are therefore always the ones the router enforces.

### Complete-triggered interactions

`report` and other interactions with `trigger: complete` have no caller:
the router fills them from the finished run. Their templates may use only
router variables, and loading fails otherwise. For a node type with
`outcome: verdict`, a run without a valid final `VERDICT:` line is delivered
as `outcome: missing`, as today. It never counts as a pass.

## Node types (plugins)

A node type is a folder with a `NODE.md`. Like an agent skill, it carries
instructions and data only, no code:

```
node-types/
  security-reviewer/
    NODE.md
    references/owasp-checklist.md    # optional; listed in the prompt, read on demand
```

```markdown
---
name: security-reviewer
description: Reviews a worktree for security defects and gives a verdict.
extends: validator
session: fresh              # fresh | resume
workspace: source           # coordinator | own-worktree | source | integration
outcome: verdict            # none | verdict
coordinator: false
fields:
  criteria:
    description: Numbered security checks for this change, in the imperative.
    type: text
---
You are the SECURITY REVIEWER for the work of '{{source.name}}'.
The implementor reported:
{{source.report}}

Check each item:
{{criteria}}
...
```

The runtime behaviour comes from a fixed set the router implements. Plugins
choose from that set but cannot add behaviour:

| Field | Values |
|---|---|
| `session` | `resume`: a long-lived session that can be compacted and can receive `deliver`. `fresh`: a new session on every run. |
| `workspace` | `coordinator`: the line workdir. `own-worktree`: a new worktree on one repo and branch. `source`: the worktree of the instance it checks. `integration`: one worktree per repo, built from the accepted commits. |
| `outcome` | `none`, or `verdict`: the router parses `VERDICT: PASS/FAIL`. |
| `coordinator` | `true`: gets the protocol section for its outgoing edges, plus registry access. |
| `requires` | `accepted-work`: the router creates the node only if every own-worktree instance's latest run has a PASS from a checker or an `accept`. This is today's integration rule. |

### Templates

Templates use a small mustache subset with no logic and no escaping:

- `{{name}}` and `{{a.b}}` insert a value.
- `{{#name}}...{{/name}}` renders its content if the value is set. If the
  value is a list, it renders once per item.
- `{{^name}}...{{/name}}` renders its content if the value is not set.

Sections are what the current prompts need: the remote block only when a
repo has a remote, the tracker-ticket line, and the per-repo commit list of
the integration brief. The rules on fields above apply to every template.

### Built-in types and personas

The current nodes become `NODE.md` files under `router-prototype/node-types/`.
Their prompts move out of `server.js` unchanged, and a test proves the
rendered text is equal.

| Type | session | workspace | outcome | coordinator |
|---|---|---|---|---|
| `planner` | resume | coordinator | none | yes |
| `implementor` | resume | own-worktree | none | no |
| `validator` | fresh | source | verdict | no |
| `integration-validator` | fresh | integration | verdict | no (`requires: accepted-work`) |

Personas are node types:
- `backend-implementor` and `frontend-implementor` extend `implementor`.
- `backend-validator` and `frontend-validator` extend `validator`.
- The frontend types add the browser, port and docker tools section.

The planner picks a persona by picking which node to start. The `default`
pipeline reproduces today's behaviour:

```yaml
name: default
start: planner
nodes:
  planner:       { type: planner }
  backend-impl:  { type: backend-implementor }
  frontend-impl: { type: frontend-implementor }
  backend-val:   { type: backend-validator }
  frontend-val:  { type: frontend-validator }
  integration:   { type: integration-validator }
edges:
  - planner -> [backend-impl, frontend-impl]: start, feedback, accept
  - [backend-impl, frontend-impl] -> planner: report
  - planner -> [backend-val, frontend-val]: start
  - [backend-val, frontend-val] -> planner: report
  - planner -> integration: start
  - integration -> planner: report
```

The router checks that a validator's `source` is an instance of a node that
pairs with it. The pairing comes from an optional `checks:` list on the
validator node, for example `backend-val: { type: backend-validator, checks: [backend-impl] }`.

**Change from today.** The router no longer reads acceptance criteria from
the planner's reply and starts the validator itself. The planner now calls
`start` on the validator with `criteria` and `source`, and calls `accept`
where it used to reply `SKIP VALIDATION`. This is one explicit API call
instead of text parsing, and the call is checked like every other call.

### Where plugins live

The router reads these folders, highest priority first. A plugin may not
reuse a built-in name; it uses `extends` to build on one instead.

1. `<LINES_DIR>/plugins/`: the managed layer. The UI writes pipelines here,
   and migrated presets land here.
2. `~/.cuck/`: user plugins.
3. `router-prototype/`: built-in. Read-only.

Each layer can have three folders: `node-types/`, `interactions/` and
`pipelines/`.

A `.cuck/` folder inside a project repository is not read in v1. A line can
have several repositories, and two of them could define the same name.

## Validation rules for a pipeline

The router rejects a pipeline that breaks any rule. The error names the rule
and the offending node, edge or field.

1. Exactly one start node. It receives the user's prompts.
2. Every node is reachable from the start node through `create` interactions.
3. The `create` edges form no cycle. Loops happen between instances
   (feedback, a fresh A2), never in the graph. This matches ADR-0005.
4. Every node except the start node has a `complete`-triggered interaction.
   Following those interactions from any node ends at the start node, so no
   result can get lost.
5. In v1, only the start node may use `request`-triggered interactions.
   Other coordinators come later and need per-instance caller tokens.
6. A `deliver` needs a target type with `session: resume`.
7. Every node type, interaction and template must load: every caller
   placeholder declared, optional fields only inside their own sections,
   `complete` templates using only router variables.
8. Unknown node types, unknown interactions, unknown nodes and duplicate
   edges are errors.

## How a node's prompt is built

Each instance gets these parts, in this order:

1. **Router rules.** These are fixed and plugins cannot remove them:
   container and process hygiene, report format, and that notices are
   untrusted.
2. **Type prompt.** The `NODE.md` bodies, `extends` parents first.
3. **Prompt extensions.** `defaults.prompt`, then the node's `prompt`, from
   the pipeline file.
4. **Protocol section.** Generated from the edges and the interaction
   definitions:
   - For a coordinator: what it may do with each node, the exact call, and
     the fields of the call.
   - For other nodes: where its report goes.

On harnesses with a trusted system-prompt channel (claude, codex, pi), this
text goes through that channel. On vibe, which has none, it goes first in the
first turn, and again when a session is reseeded after compaction.

## Router API

- `POST /api/protocol/lines/:id/interactions/:name {to, ...fields}` is the
  one call for every request-triggered interaction. For `chosen` targets,
  `instance` replaces `to`.
- `GET /api/protocol/lines/:id/interactions` shows what the caller may do,
  with the field lists.
- The router performs `complete`-triggered interactions itself.
- The existing `/workers`, `/continue` and `/integration` routes stay as
  aliases for the `default` pipeline.

## Lines

A line names a pipeline when it is created (default: `default`). The router
validates it, resolves every type and interaction, and stores the resolved
definition in `line.json` as `graph`. Editing a file later does not change a
running line. A running line can change only its node run settings, never
its graph.

## Migration from the current configuration

Phases map to node types. Every mapping below uses this table:

| Phase (today) | Node types it maps to | Env prefix |
|---|---|---|
| `planner` | `planner` | `PLANNER_` |
| `implementor` | `implementor` and every type that extends it | `IMPLEMENTOR_` |
| `validator` | `validator` and every type that extends it | `VALIDATOR_` |
| `integration` | `integration-validator` and its children | `INTEGRATION_` |

- **Environment variables.** `PLANNER_HARNESS`, `IMPLEMENTOR_MODEL` and the
  other prefixed variables keep working. Each is the default for every node
  whose type maps to that phase. Node settings in the pipeline file win over
  them.
- **Lines.** A `line.json` without `graph` loads with the `default`
  pipeline:
  - Its `pipeline` overrides become run settings on the nodes of the mapped
    types.
  - Each worker gets a `node`:
    - An implementor maps to `backend-impl` or `frontend-impl`, by persona.
    - A validator maps to `backend-val` or `frontend-val`, by persona.
    - An integration validator maps to `integration`.
  - A `SKIP VALIDATION` already recorded becomes an `accept` record.

  The router writes the migrated form on the next save.
- **Presets.** On the first start, each entry in `pipeline-presets.json`
  becomes `<LINES_DIR>/plugins/pipelines/<preset-name>.yaml`. The file is the
  `default` pipeline with the preset's settings on the mapped nodes. The
  router renames the old file to `pipeline-presets.json.migrated`. A preset
  name that is not a safe file name is changed, and the boot log shows the
  new name.
- **In-flight criteria.** A planner request that already waits for
  acceptance criteria keeps the old flow until it completes: the router
  reads the criteria from the reply and starts the validator. New implementor
  reports use the new flow only. The old code is removed in a later release.
- **API.** For one release, the old request shapes keep working:
  - `POST /api/lines {pipeline: {<phase>: settings}}` and
    `PUT /api/lines/:id/pipeline {pipeline: {...}}` map phases to nodes.
  - `GET` responses carry both the node settings and the old per-phase view.
  - The old routes `/workers`, `/continue` and `/integration` are aliases
    for interactions. `/workers` with `persona` starts the matching
    implementor node.
- **UI.** The phase rows and the presets bar are replaced (see below). A
  bookmark or script that uses the preset API gets 410 with a pointer to the
  pipelines API.

## UI

- **Create panel.**
  - A pipeline picker lists the pipelines from every layer, with name,
    description and layer.
  - Under the picker, a settings form shows one row for each node of the
    chosen pipeline: harness, auth mode, model, effort and max context, as
    today's phase rows have.
  - "Save as pipeline" writes the chosen pipeline, with the form's settings,
    to the managed layer under a new name. It replaces "Save as preset".
- **Pipeline tab of a line.**
  - The graph view: nodes, with arrows labelled by interaction names.
  - The effective settings per node, and the settings form for this line.
    The graph structure is shown read-only.
- **Pipelines page** (`/pipelines`).
  - Lists every pipeline, node type and interaction, by layer.
  - Built-in and user files are read-only and have a "Duplicate to edit"
    button.
  - Managed files open in an editor: YAML text on one side, the live graph
    preview and the validation errors on the other.
  - Saving runs the same validation as line creation. A file with errors
    cannot be saved.
  - A pipeline that a line uses can still be edited, because the line keeps
    its own resolved copy.

## Delivery plan

1. **Formats.** The loaders for node types, interactions and pipelines, the
   template engine, field derivation, and the pipeline validation rules. All
   of it is pure and tested. The built-in files are extracted, and a test
   proves the rendered prompts equal today's briefs.
2. **Graph-driven router.** Nodes replace phases, `line.json` stores the
   resolved definition, and the `default` pipeline reproduces today's flow.
   The full suite stays green.
3. **Strict interactions.** The generic interaction endpoint with field
   checking and the error format, the introspection route, the generated
   protocol section, and `accept`.
4. **Plugins, migration and UI.** Plugin layers, the preset migration, the
   pipelines API, the create panel, the pipeline tab, the pipelines page,
   and an end-to-end plugin example.

The task list for these steps is in `pipeline-graph-tasks.md`.

## Decisions

- **Format: YAML.** Pipeline files and frontmatter use YAML, parsed with the
  `yaml` npm package, the router's first dependency.
- **Coordinators: the start node only in v1** (rule 5).
- **Rejections go to the coordinator.** Edges carry no outcome conditions.
- **Personas are node types** that extend the base types.
- **Interactions are files** built on fixed effects, triggers and targets.
  Edges name interactions and have no grammar of their own.
- **Strict calls.** The required fields are derived from every template the
  call fills. Every caller placeholder must be declared. A call that is
  missing, invalid or carries extra fields gets one 400 that lists every
  problem.
- **Prompt extensions in the pipeline file.** `defaults.prompt` and a node's
  `prompt` (inline or `{file}`) extend system prompts with no extra plugin
  file. They follow the same field rules.
