# router-prototype

A minimal software factory: a single-page web UI plus a Node router server, where
each "production line" is a headless Vibe CLI process. The router queues prompts
per line (strictly serial), keeps each line's Vibe session alive via session
resume so full conversation context is preserved across prompts, and streams
every Vibe output entry to the browser over SSE in real time.

## Run

```
node server.js
```

Then open http://localhost:7788. The dashboard uses one tagged SSE stream at
`GET /api/events` per browser tab; the legacy per-line stream endpoint remains
available for compatibility. Configuration via env: `PORT` (default 7788),
`ROUTER_HOST` (the address the router listens on; default `127.0.0.1`; any
other value lets other computers send commands to the router, which has no
authentication), `ROUTER_ALLOWED_HOSTS` (comma-separated extra host names
accepted in the `Host` header; default empty; use only together with
`ROUTER_HOST`), `LINES_DIR` (default `./lines`), `IMPLEMENTOR_MODEL` (default `glm-5-3-flash`,
the fast model) and `VALIDATOR_MODEL` (default `glm-5-3`, the full-effort
model). Git commands run non-interactively (`GIT_TERMINAL_PROMPT=0` and
`GCM_INTERACTIVE=Never`, inherited by workers). Configure repository credentials
before starting the router; missing credentials fail the operation instead of
prompting for a login in the server terminal.
For a browser-facing HTTPS/HTTP/2 endpoint, start the router with
`HTTPS_PORT=7789 TLS_KEY=/path/to/key.pem TLS_CERT=/path/to/cert.pem`; trust
the certificate's local CA and open `https://localhost:7789`. Node serves this
TLS listener directly while worker and CLI traffic stays on HTTP port 7788. The
router pins each vibe session to its role's model via
`VIBE_ACTIVE_MODEL` in the spawn environment; planner runs inherit the ambient
config. Requires Node >= 18 and the `vibe` CLI on PATH.

## Markdown browser fixture

Start the local fixture for browser checks:

```
node test/fixtures/markdown-browser.js
```

Set `PORT` for a specific port. The command prints the fixture URL. Stop it
with Ctrl-C. Tests can call `startMarkdownFixture({ port })` and await `close()`.

## Tests and static validation

Run these commands from the repository root:

```
node --test router-prototype/test/*.test.js
node router-prototype/scripts/validate-build.js
```

The first command runs the complete unit test suite. The second parses the
production server and browser JavaScript, the inline scripts in `web/index.html`,
and checks required and referenced local web assets. It does not execute scripts
or start the router. This plain-JavaScript application has no transpilation or
bundling build; static validation is not a compile or integration test.

Evidence validation requires `ffmpeg` on `PATH` or `EVIDENCE_FFMPEG`; it uses
fixed arguments, one decoded frame, a timeout, and bounded output. Tests generate real media in temporary folders and fail when `ffmpeg` is missing.

## Dashboard browser fixture

A tester can serve the real dashboard page and the real server code on
`127.0.0.1` with a fake planner child and a fake clock. No real planner or
provider runs. Start it from `router-prototype/`:

```
PORT=0 node test/fixtures/dashboard-browser.js
```

`PORT` is optional; the default `0` selects a free port. The fixture prints
the URL and stops on SIGINT or SIGTERM. It seeds one idle line.

## Dashboard browser check

This check opens the dashboard fixture in a real headless Chrome and reports JSON:

```
node test/fixtures/dashboard-browser-check.js
```

Exit codes: `0` pass, `1` fail, `3` no browser (`BROWSER_UNAVAILABLE`; not a pass).
The `CHROME_BIN` variable sets the browser path. The default is Google Chrome on macOS.

## Planner and worker text handoff

The router uses one text contract for a completed message: normalized entries
use `text`; older entries can use a string or an array of `{ type: "text", text }`
blocks in `content`. It accepts text from assistant messages only. It excludes
thinking, tool calls, tool results, malformed blocks, and other roles. Vibe and
Pi preserve the source role and never default an unknown or missing role to
assistant. Codex `agent_message` and Claude `assistant` events imply assistant
only when the schema omits role; an explicit contradictory role is rejected.
Pi finalization flushes only text from `assistantMessageEvent`, and a completed
non-assistant message clears any pending partial text.

Each planner or worker process has a separate output capture. It collects every
assistant text entry from that process run. The UI transcript can keep its
500-entry limit without cutting the criteria or report sent to another stage.
For Pi JSON mode, `message_end.message` is authoritative. The adapter replaces
streaming deltas with the completed message and does not append them twice. A
`text_end` block replaces its partial deltas. If Pi closes before a completed
message, the adapter flushes the buffered block text.
The JSONL decoder handles split records, LF or CRLF framing, and a final record
without LF. It does not split on Unicode line separators.

The planner gives the criteria for validation in an explicit `start` call of a
validator node, with `criteria` and `source` (see "Validation loop"). It
accepts work without a check with the `accept` interaction; the text
`SKIP VALIDATION` is no longer the way to do this. The rest of this
paragraph describes the older flow, which the router keeps only for a planner
request that already waits for criteria (it is removed in a later release, task
D9). In that flow the criteria come only from the current planner run.
Empty criteria produce a `VALIDATION NOT STARTED` diagnostic. They do not use
old transcript text and do not start a validator. `SKIP VALIDATION` is
still understood there. Each implementor report enters the planner queue
with trusted internal source metadata: worker ID, invocation ID, run generation,
and the immutable report body. Planner dispatch and wake retries preserve that
metadata. Criteria are accepted only for that exact source, never by parsing
worker IDs from prompt text or reading the worker's mutable latest report. If a
continuation supersedes the source before criteria return, the router reports
cancellation and keeps the newer report request intact. Deferred validation
stores its criteria, report, and invocation identity together. Worker
completion sets status and verdict before
saving state or sending the status event. A verdict requires the final non-empty
report line to be exactly `VERDICT: PASS` or `VERDICT: FAIL`; a missing or
incomplete verdict stays unset and produces a diagnostic. Report bodies are
sent in full, without adding punctuation to the report text.

## Graph lanes

The graph places each standard validator in the lane of the implementor it validates. The first validator shares the implementor row, and later validators use rows below it. Each implementor lane has at least one row. Unmatched validators use an ordered fallback section. Integration validators use a separate final section, with eligible Preview nodes on their integration row. The failed-validator filter runs before row sizing, so hidden validators do not leave empty rows. Graph selection keeps the fixed viewport position.

## Pipelines, node types and interactions

The shape of a line is data, not code. A **pipeline file** lists the nodes of a
line, the one start node (the planner) and which **interactions** each node may
have with which other node. A **node type** (`NODE.md`) defines a role and its
system prompt. An **interaction** (`INTERACTION.md`) defines one kind of
communication: what it does, which values the caller must supply, and the
message it delivers. The built-in files live in `router-prototype/pipelines/`,
`node-types/` and `interactions/`. The design is in
`docs/pipeline-graph-design.md`.

**Status.** The router, the files, the plugin layers, the strict calls and the
pipelines HTTP API are built. The web UI is not: the create-panel pipeline
picker, the Pipeline tab with the graph view and the `/pipelines` page (tasks D4
to D6) do not exist yet. The web UI still shows the four per-phase rows, and it
sends the old per-phase `pipeline` shape (the router still accepts it).
Pipelines are managed today through the HTTP API below or by files on disk.

### Concepts

| Term | Meaning |
|---|---|
| Node type | A reusable role: prompt plus runtime behavior. Example: `validator`. |
| Node | One use of a type in a pipeline, with its own id and run settings. Example: `backend-val`. |
| Instance | One running agent of a node (a worker). A node can have many. |
| Interaction | A kind of communication: `start`, `feedback`, `accept`, `report`. |
| Edge | Permission for one node to use one or more interactions toward another node. |

A line stores the resolved pipeline in `line.json` as `graph` when it is
created (`POST /api/lines {pipelineName}`, default `default`; an unknown name is
400 and lists the known names). Editing a file later does not change a running
line. A line saved before this feature gets the `default` graph when it loads;
its `pipeline` overrides become `nodeSettings`, each worker gets a `node`, and
an earlier `validationSkipped` becomes an entry in `acceptedRuns`.

### Pipeline file

A pipeline is a YAML file `<name>.yaml` in a `pipelines/` folder. This is the
built-in `pipelines/minimal.yaml`:

```yaml
name: minimal
description: One planner, one implementor, one validator and an integration validator.
start: planner

nodes:
  planner:     { type: planner }
  impl:        { type: implementor }
  val:         { type: validator, checks: [impl] }
  integration: { type: integration-validator }

edges:
  - planner -> impl: start, feedback, accept
  - impl -> planner: report
  - planner -> val: start
  - val -> planner: report
  - planner -> integration: start
  - integration -> planner: report
```

Top-level keys: `name` (required), `description`, `start` (required),
`defaults` (only `prompt`), `nodes`, `edges`. A node has `type` (required), the
run settings `harness`, `model`, `effort`, `timeLimit`, `maxContext`, plus
`prompt`, `fields` and `checks`. Any other key is an error.

- An edge is `<from> -> <to>: <interaction>[, <interaction>...]`. Either side
  can be a list: `"[a, b] -> c: report"`. An edge that starts with `[` must be
  quoted, because YAML would read it as a list. The names after the colon are
  interaction names; their meaning is in the interaction files. Two edges for
  the same `from` and `to` are an error.
- `checks: [impl]` on a node whose type has `workspace: source` names the
  implementor nodes it checks. The `source` of a `start` call must be an
  instance of one of them.
- A pipeline name is 1 to 60 characters of `a-z`, `0-9` and `-`, and starts
  with a letter or digit (`^[a-z0-9][a-z0-9-]{0,59}$`).

### Node type: `NODE.md`

A node type is a folder with a `NODE.md`: YAML frontmatter, then the prompt
template. Like an agent skill it holds instructions and data only, no code.
This is the head of the built-in `node-types/backend-validator/NODE.md`:

```markdown
---
name: backend-validator
description: Validator with the backend and architecture persona.
extends: validator
---
Your validation persona: backend / architecture.
...

<!-- task -->
The implementor reported:
{{source.report}}

The planner gave these acceptance criteria:
{{criteria}}
```

The folder name must equal `name` (`^[a-z][a-z0-9-]{0,63}$`). Frontmatter keys:

| Key | Values |
|---|---|
| `description` | Text. Shown in the generated protocol text of the planner. |
| `extends` | The name of a parent type. The bodies are joined (parent first), the `fields` are merged, and the child overrides the other keys. A child cannot declare a field of its parent in a different way. A loop is an error. |
| `session` | `resume`: a long-lived session that can be compacted and can receive `feedback`. `fresh`: a new session on every run. |
| `workspace` | `coordinator`: the line workdir. `own-worktree`: a new worktree on one repository and branch. `source`: the worktree of the instance it checks. `integration`: one worktree per repository, built from the accepted commits. |
| `outcome` | `none`, or `verdict`: the router reads the final `VERDICT: PASS` or `VERDICT: FAIL` line. A run without it is reported as `missing`, never as a pass. |
| `coordinator` | `true`: the node gets the generated protocol text for its outgoing edges. Default `false`. |
| `requires` | A list. The only value is `accepted-work`. It is parsed and stored; the router enforces the accepted-work rule when it starts an integration node (409 with `blockers`, see "Remote pipeline"). |
| `fields` | The caller fields the template uses (see "Fields"). |

A type without `extends` must set `session`, `workspace` and `outcome`. The
built-in types: `planner` (resume, coordinator), `implementor` (resume,
own-worktree), `validator` (fresh, source, verdict), `integration-validator`
(fresh, integration, verdict), and the personas `backend-implementor`,
`frontend-implementor`, `backend-validator`, `frontend-validator`. The planner
picks a persona by starting the node of that persona.

### Interaction: `INTERACTION.md`

An interaction is a folder with an `INTERACTION.md`. The frontmatter says what it
does and what values it needs; the body is the message template. This is the
built-in `interactions/feedback/INTERACTION.md`:

```markdown
---
name: feedback
description: Send follow-up instructions to an existing instance. It resumes its session.
effect: deliver
trigger: request
target: chosen
fields:
  instructions:
    description: The corrected or additional instructions, written for the instance.
    type: text
    maxLength: 20000
---
Follow-up instructions from the planner (write them in ASD-STE100):
{{instructions}}

When done, reply with a report: what you changed, files changed, how you verified it, open issues. That report goes back to the planner verbatim.
```

| Key | Values |
|---|---|
| `effect` | `create`: a new instance of the target node; the message is its first turn. `deliver`: the message goes into an existing instance and wakes it. `accept`: records an acceptance and sends no message (the body must be empty); only built-in interactions may use it. |
| `trigger` | `request`: the planner calls the router API. `complete`: the router acts when a run of the sender ends. |
| `target` | `new` (only with `create`), `chosen` (an instance the caller names; needs `request`), `starter` (the instance that created the sender), `source` (the instance whose work the sender checks). |

The built-in interactions:

| Name | effect | trigger | target | Caller fields |
|---|---|---|---|---|
| `start` | create | request | new | whatever the target node needs, see "Strict calls" |
| `feedback` | deliver | request | chosen | `instance`, `instructions` |
| `accept` | accept | request | chosen | `instance`, `reason` |
| `report` | deliver | complete | starter | none; the router fills `report` and `outcome` |

A `complete`-triggered interaction has no caller. It declares no `fields` and
its template may use router variables only. Its text depends on the outcome
(`outcome.done`, `outcome.pass`, `outcome.reject`, `outcome.missing`,
`outcome.timeout`, `outcome.failed`, `outcome.stopped`) and on the type of the
sender (`from.type.implementor`, `from.type.validator`, `from.type.integration`).

### Plugin layers

The router reads three folders, highest priority first. Each can hold
`node-types/`, `interactions/` and `pipelines/`.

| Layer | Where | Notes |
|---|---|---|
| managed | `<LINES_DIR>/plugins/` (default `./lines/plugins`) | The pipelines API writes here (`pipelines/` only). Migrated presets land here. |
| user | `$CUCK_HOME`, else `~/.cuck` | Your own plugins. Read-only for the API. |
| built-in | `router-prototype/` | Read-only. |

- A name in a higher layer wins over the same name in a lower plugin layer (the
  lower file is ignored).
- A plugin may **not** reuse a built-in name. The built-in one is kept, the
  plugin file is skipped, and the clash is listed under `problems` of
  `GET /api/pipelines` and in the boot log. Use `extends` to build on a built-in
  type instead. `extends` works across layers, so a user type can extend
  `validator`.
- A file that does not load (a format error, a broken template) is skipped and
  listed under `problems`. The other files still work.
- The catalog is read at boot and again after each write through the pipelines
  API. After you edit a file on disk by hand, restart the router.
- A `.cuck/` folder inside a project repository is not read.

### Templates

Templates use a small mustache subset, with no logic and no escaping:

- `{{name}}` and `{{a.b}}` insert a value. A missing value is an error. The
  router never sends a prompt with an unfilled placeholder.
- `{{#name}}...{{/name}}` renders its content when the value is set (not
  missing, not empty, not `false`). For a list, it renders once per item.
- `{{^name}}...{{/name}}` renders its content when the value is not set.
- The marker `<!-- task -->` splits a type body into a role part (before) and a
  task part (after). A prompt has at most one marker. The marker is removed
  from the text. On harnesses with a trusted system-prompt channel (`claude`,
  `codex`, `pi`), the role part, together with the prompt extensions (below), is
  sent through that channel and the task part is the first turn. On `vibe`,
  which has none, the whole prompt is the first turn.

**Router variables and caller fields.** The router fills these and never
accepts them from a caller: `line.*`, `node.*`, `instance.*`, `from.*`,
`repo.url`, `repo.name`, `router.url`, `router.workerCap`, `source.name`,
`source.id`, `source.report`, `source.harness`, `source.session`, `report`,
`outcome`, `outcome.*`, `integration.*`, `protocol`. Every other `{{name}}` is
a **caller field**: the caller supplies it, and it must be declared.

### Fields

Every caller field must be declared under `fields` in the interaction, the node
type or the pipeline node that uses it. A placeholder without a declaration
fails loading. A declaration:

```yaml
fields:
  criteria:
    description: Numbered acceptance criteria, one check per line, in the imperative.
    type: text
  trackerTicket:
    description: Ticket id that every branch name must start with.
    type: string
    pattern: "^[A-Z]+-[0-9]+$"
    optional: true
```

Keys: `description` (required, 1 to 300 characters), `type` (required), and
for some types `maxLength`, `pattern`, `values`, `node`, `optional`. Types:
`string` (one line, at most 200 characters unless `maxLength` is set, optional
`pattern`), `text` (at most 20000 characters unless `maxLength` is set), `enum`
(needs `values`), `instance` (an instance of the line; `node` narrows it),
`repo` (a registered repository of the line) and `commit` (40 lowercase hex
characters that exist in the repository). A field is required and must be
non-empty, unless it has `optional: true`. An optional field may be used only
inside a section for that field (`{{#trackerTicket}}...{{/trackerTicket}}`),
so an optional value can never leave a hole in a prompt.

### Strict calls

`POST /api/protocol/lines/:id/interactions/:name` rejects any call that does
not supply exactly the values it needs. The **required fields** of a call are
the union of:

1. The caller fields in the interaction template.
2. For `effect: create`: the caller fields in everything the new instance's
   prompt is built from: the `NODE.md` of the target type and its parents, and
   the prompt extensions of the pipeline file.
3. The fields the effect needs: `instance` for a `chosen` target; `repo` (and
   the optional `base`) when the target type has `workspace: own-worktree`;
   `source` when it has `workspace: source`; and the optional `name` of every
   new instance.

A call with missing, invalid or unexpected fields answers one 400 that lists
every problem, so the caller can fix all of them in one retry. This is a real
answer from the `default` pipeline for
`{"to": "backend-impl", "persona": "x"}`:

```json
{
  "error": "start of node 'backend-impl' is incomplete: fill every listed field",
  "code": "INTERACTION_FIELDS",
  "interaction": "start",
  "to": "backend-impl",
  "missing": [
    { "field": "task", "description": "The complete task for the implementor, as the planner writes it.", "requiredBy": "node type backend-implementor" },
    { "field": "repo", "description": "The registered repository the new instance works in.", "requiredBy": "workspace: own-worktree" }
  ],
  "invalid": [],
  "unexpected": ["persona"],
  "expected": {
    "trackerTicket": "string ^[A-Z]+-[0-9]+$, optional",
    "task": "text, required",
    "repo": "repo, required",
    "base": "string, optional",
    "name": "string, optional"
  }
}
```

Other answers: 403 `NO_EDGE` (with `allowed`: the calls the planner may make
instead) when no edge allows that interaction toward that node; 404 for an
unknown line, interaction, node or instance; 405 for a `complete`-triggered
interaction (the router performs those itself); 409 `plan not approved` before
plan approval. A field of type `instance` must name an existing, idle instance
of the right node. `GET /api/protocol/lines/:id/interactions` lists what the
planner may do, per target node, with the field list of each call.

### Pipeline validation rules

The router rejects a pipeline that breaks a rule when a line is created and
when the pipelines API saves or validates it. Each error has a `rule` and a
`message` that names the node, edge or field.

| Rule | Meaning |
|---|---|
| R1 | The `start` node exists in `nodes`. |
| R2 | Every node can be reached from the start node through `create` interactions. |
| R3 | The `create` edges form no cycle. Loops happen between instances (feedback, a fresh instance), never in the graph. |
| R4 | The result of every other node cannot get lost: following `complete`-triggered interactions from any node ends at the start node. |
| R5 | Only the start node may use `request`-triggered interactions. |
| R6 | A `deliver` interaction needs a target node whose type has `session: resume`. |
| R7 | The prompt extensions (`defaults.prompt`, node `prompt`) parse, every caller field in them is declared, optional fields are used only in their own sections, and the node `fields` declarations are valid. |
| R8 | No unknown node type, unknown node (in an edge or in `checks`), unknown interaction or duplicate edge. |
| R9 | A node with `checks` has a type with `workspace: source`, and each node it checks has a type with `workspace: own-worktree`. |
| R10 | A `complete`-triggered interaction does not have `effect: create`. |

Two more error codes can appear: `LOAD` (the text, a node type, an interaction
or a prompt file does not parse or load) and `NAME` (the name is not allowed,
differs from the file name, or is a built-in name).

### Prompt extensions

A node's system prompt can be extended in the pipeline file, without a new type
file. `defaults.prompt` applies to every node; a node's `prompt` is added after
it. A prompt is inline text or `{ file: <path> }`. The file is relative to the
folder of the pipeline file and must stay inside it.

```yaml
defaults:
  prompt: |
    The product is a payments service. Never log card numbers or tokens.

nodes:
  A:
    type: implementor
    prompt: |
      Follow the error-handling rules in docs/errors.md.
  B:
    type: security-reviewer
    prompt:
      file: prompts/pci-checks.md
    fields:
      riskLevel:
        description: The risk level of the change, from the planner's assessment.
        type: enum
        values: [low, medium, high]
```

An extension is a template: router variables work, and a caller field must be
declared under the node's `fields` (or the type's). It then becomes a required
field of every `start` of that node. An extension adds text only: it cannot
change the runtime behavior of the type.

### How the prompts are built

The prompt of an instance is the rendered `NODE.md` bodies (parents first), then
`defaults.prompt`, then the node `prompt`. The built-in bodies carry the router
rules (container and process hygiene, report format). The planner prompt has
the placeholder `{{protocol}}`. The router fills it for a node whose type has
`coordinator: true` with a section "Calls", generated from the edges that leave
that node and the interaction definitions: for each call that the planner may
make, a short description, the exact `curl` command with the required fields,
and the list of all fields with their type and description. It comes from the
same data as `GET /api/protocol/lines/:id/interactions`, so the planner prompt
documents the fields the router enforces. A node that is not a coordinator gets
no such section.

### Presets are now pipelines

The old pipeline presets are gone. At boot, the router converts each entry of
`<LINES_DIR>/pipeline-presets.json` to `<LINES_DIR>/plugins/pipelines/<name>.yaml`:
the `default` pipeline with the preset settings placed on the nodes of each phase,
and the description `Migrated from preset '<old name>'`. A preset name that is
not a safe file name is changed (lowercase, `a-z0-9-`, at most 60 characters,
`-2`, `-3` ... for a clash) and the boot log shows `preset migrated: '<old>' ->
'<new>'`. The old file is renamed to `pipeline-presets.json.migrated`. The
routes `GET`, `PUT` and `DELETE /api/pipeline-presets*` answer 410
`{error, use: "/api/pipelines"}`.

## Write a node type

This example adds a `security-reviewer`: a validator that checks the work for
security defects and has one extra field of its own, `riskLevel`.

1. **Make the folder.** Put it in the user layer, for example
   `~/.cuck/node-types/security-reviewer/NODE.md` (or in
   `<LINES_DIR>/plugins/node-types/`). The folder name must equal `name`.

   ```markdown
   ---
   name: security-reviewer
   description: Reviews the work of an implementor for security defects and gives a verdict.
   extends: validator
   fields:
     riskLevel:
       description: The risk level of the change, from the planner's assessment.
       type: enum
       values: [low, medium, high]
   ---
   Your role: SECURITY REVIEWER. The risk level of this change is {{riskLevel}}.
   Check the work for injection, broken access control, secrets in code or logs,
   unsafe deserialization, and missing input validation. For risk level high,
   also check every new dependency.

   <!-- task -->
   The implementor reported:
   {{source.report}}

   The planner gave these security checks:
   {{criteria}}

   Tasks:
   1. Check the work against each security check. For each check, record PASS
      or FAIL with one sentence of evidence.
   2. Reply with a SECURITY REPORT: one line per check with PASS or FAIL, then
      a final line "VERDICT: PASS" or "VERDICT: FAIL".
   ```

   `extends: validator` gives the type `session: fresh`, `workspace: source`,
   `outcome: verdict`, the field `criteria`, and the validator rules (hygiene,
   remote and CI section). The `<!-- task -->` marker puts the role text
   before it into the system prompt and the rest into the first turn.
   `{{source.report}}` is a router variable; `{{criteria}}` comes from the
   parent; `{{riskLevel}}` is a caller field and so it is declared.

2. **Add it to a pipeline.** Put the node in a pipeline file, and let the
   planner start it on the work of an implementor. Name the node it checks with
   `checks`. Save this as `review-gate.yaml`:

   ```yaml
   name: review-gate
   description: Implement, check the work, then a security review of the same work.
   start: planner

   nodes:
     planner: { type: planner }
     impl:    { type: implementor }
     val:     { type: validator, checks: [impl] }
     sec:     { type: security-reviewer, checks: [impl] }

   edges:
     - planner -> impl: start, feedback, accept
     - impl -> planner: report
     - planner -> [val, sec]: start
     - "[val, sec] -> planner: report"
   ```

   The `report` edge from `sec` to the planner satisfies rule R4: the verdict
   of the reviewer goes back to the planner, which decides.

3. **Check it.** Restart the router so that it reads the user layer. Then send
   the text to the validator. It writes nothing:

   ```
   curl -s -X POST http://localhost:7788/api/pipelines/validate \
     -H 'Content-Type: application/json' \
     -d "$(node -e 'console.log(JSON.stringify({text: require("fs").readFileSync("review-gate.yaml", "utf8")}))')"
   ```

   A good file answers 200 with `"errors": []` and the graph:

   ```json
   {"errors":[],"graph":{"nodes":[{"id":"planner","type":"planner","phase":"planner"},
     {"id":"impl","type":"implementor","phase":"implementor"},
     {"id":"val","type":"validator","phase":"validator"},
     {"id":"sec","type":"security-reviewer","phase":"validator"}],
    "edges":[{"from":"planner","to":"impl","interactions":["start","feedback","accept"]},
     {"from":"impl","to":"planner","interactions":["report"]},
     {"from":"planner","to":"val","interactions":["start"]},
     {"from":"planner","to":"sec","interactions":["start"]},
     {"from":"val","to":"planner","interactions":["report"]},
     {"from":"sec","to":"planner","interactions":["report"]}]}}
   ```

   A broken file answers 200 as well, with the list of errors and
   `"graph": null`. If you remove the edge `planner -> [val, sec]: start`, the
   answer is `{"errors":[{"rule":"R2","message":"node 'sec' cannot be reached
   from start node 'planner' through create interactions"}],"graph":null}`.
   A node type that does not load is not in the catalog: the answer then
   has `R8` (`unknown node type`), and the load error is under `problems` of
   `GET /api/pipelines`.

4. **Save and use it.** `PUT /api/pipelines/review-gate {text}` saves the file
   to the managed layer (201), and `POST /api/lines {pipelineName:
   "review-gate"}` creates a line with it. The call that starts the reviewer
   needs three fields besides `to`:

   ```
   POST /api/protocol/lines/:id/interactions/start
   {"to": "sec", "source": "<implementor id>", "criteria": "1. No secrets in logs.", "riskLevel": "high"}
   ```

   Without `riskLevel` and `source`, the router answers 400
   `INTERACTION_FIELDS` with both in `missing` and the description of each. A
   `riskLevel` that is not `low`, `medium` or `high` is listed under `invalid`
   with the reason `must be one of: low, medium, high`. The field list also
   shows in `GET /api/protocol/lines/:id/interactions` and in the planner prompt.

**Limit of this version.** The router checks every declared field of a call, but
for the nodes it starts it passes only fixed values to the prompt: `task` (and
`trackerTicket`) for an implementor, `criteria` (and `trackerTicket` from the
implementor) for a validator, and `instructions` for an integration validator.
A node type that uses another caller field in its template, like `riskLevel`
above, passes the format checks and the call checks, but the start of the node
fails with 500 (`Missing value "riskLevel"` in the prompt build) because the
value is not forwarded yet. Until the router forwards custom fields, use only
`criteria` in the template of an extended validator. The design says that the
declared fields become part of the prompt; this part is not built.

## Pipelines HTTP API

These routes read and write pipeline files. Only the managed layer
(`<LINES_DIR>/plugins/pipelines/<name>.yaml`) can be changed. Built-in and user
pipelines are read-only: duplicate one to edit it. A pipeline name follows the
rules above. A running line keeps its own resolved copy, so changing or
deleting a file never changes a running line. The web UI for these routes (the
`/pipelines` page) is not built yet (task D6).

| Route | Answer |
|---|---|
| `GET /api/pipelines` | 200 `{pipelines: [{name, description, layer, editable, problems}], nodeTypes: [{name, layer}], interactions: [{name, layer}], problems: [{layer, path, errors}]}`. `layer` is `managed`, `user` or `built-in`; `editable` is true for `managed` only. A pipeline that does not resolve has its errors in its own `problems`. Other methods: 405. |
| `GET /api/pipelines/:name` | 200 `{name, layer, editable, text, resolved, errors}`: the file text, and the resolved definition (`resolved` is `null` and `errors` is filled when it does not resolve). 404 for an unknown or malformed name. |
| `POST /api/pipelines/validate {text}` | 200 `{errors: [{rule, message}], graph}` where `graph` is `{nodes: [{id, type, phase}], edges: [{from, to, interactions}]}`, or `null` when `errors` is not empty. It runs the same validation as line creation and writes nothing. A name that clashes with a built-in or user pipeline is a `NAME` error. 400 when `text` is not a string or the body is not JSON; 413 when `text` is larger than 256 KB. |
| `PUT /api/pipelines/:name {text}` | Validates, then writes the file atomically and reloads the catalog. 201 when the file is new, 200 when it replaced one: `{name, layer: "managed", editable: true}`. 400 `{error}` for a bad name or a body without a text; 400 `{error, errors}` for a validation error (the `name` in the text must equal `:name`); 403 when `:name` is built-in or in the user layer; 413 for text over 256 KB. |
| `DELETE /api/pipelines/:name` | 200 `{deleted: true}`. 403 for a built-in or user pipeline; 404 when there is no such file. |
| `POST /api/pipelines/:name/duplicate {newName}` | Copies a pipeline of any layer into the managed layer under `newName`; only the `name:` value in the text changes. 201 `{name, layer: "managed", editable: true}`. 404 for an unknown source; 400 for a bad `newName` or a copy that does not validate; 409 when `newName` already exists. |

Errors of the write routes carry `error` (a one-line text of the rules) and
`errors` (the list of `{rule, message}`). Any other method or path below
`/api/pipelines` answers 405 or 404.

## Pipeline settings

Every node of a line has run settings: `harness`, `model`, `effort`,
`timeLimit` and, for a node whose type has `session: resume`, `maxContext` (see
Context compaction). Unset fields use the router defaults and the
`<PHASE>_HARNESS` / `_MODEL` / `_EFFORT` environment variables. The phase of a
node comes from its type: `planner` is `planner`; `implementor` and every type
that extends it are `implementor`; `validator` and its children are
`validator`; `integration-validator` is `integration`. An environment variable
applies to every node of its phase.

- Settings of a new line: `POST /api/lines {pipelineName?, nodeSettings?}`.
  `nodeSettings` is `{ "<nodeId>": {harness?, model?, effort?, timeLimit?,
  maxContext?} }`. An unknown node or an unknown key is 400. The pipeline file
  can also hold the settings of its nodes (`harness`, `model`, ...); the line
  settings win over them.
- The old per-phase shape `pipeline: {<phase>: settings}` is still accepted on
  `POST /api/lines` and `PUT /api/lines/:id/pipeline`; the router maps it to the
  nodes of that phase. Send either `nodeSettings` or `pipeline`, not both (400).
- Change a running line with `PUT /api/lines/:id/pipeline {nodeSettings}` (or
  `{pipeline}`). The new map replaces the old one; `pipeline: null` resets to the
  defaults. Only the run settings can change, never the graph. Changes apply
  from the next run: running sessions finish unchanged, and existing workers
  keep the harness, model, and effort they were spawned with. A session belongs
  to the harness that created it, so after a planner harness change the router
  compacts the planner session on the old harness and continues in a fresh
  session on the new one.
- Line state and the `PUT` answer carry `graph`, `nodeSettings`,
  `effectiveNodeSettings` (the result per node), and the old per-phase view
  `pipeline` (effective) and `pipelineOverrides`. The old per-phase view uses
  the first node of each phase.
- Presets (named settings in `pipeline-presets.json`) no longer exist; they
  became pipeline files (see "Presets are now pipelines").
- The web UI still shows the per-phase rows and the Pipeline tab of the old
  design. It does not show nodes or the graph yet (see the Status note above).

## Context compaction

Planner and implementor sessions are resumed on every run, so their context
grows. The router compacts a session in two steps that work the same on every
harness: a summary turn on the old session asks for a handoff summary, then the
router drops the session id. The next run starts a fresh session whose prompt
carries the role brief (planner brief or the worker's original brief), the
summary, and the new message. Validators start fresh on every run and are never
compacted.

Context size comes from the harness itself: `usage` on the claude and pi
streams, `stats.context_tokens` in vibe's `~/.vibe/logs/session/*/meta.json`
(`VIBE_HOME`), and the last `token_count` in codex's
`~/.codex/sessions/**/rollout-*-<session>.jsonl` (`CODEX_HOME`). Without one,
the router estimates prompt and reply characters / 4. That lower bound ignores
tool output and is shown as `~` in the UI.

- Automatic: before the next run, a session at or above its threshold is
  compacted. Set it per line with `nodeSettings.<node>.maxContext` for a node
  whose type has `session: resume` (the old shape `pipeline.planner.maxContext`
  and `pipeline.implementor.maxContext` still works; tokens; the create form
  takes `200K`, `50K`, `1M`). The default is `COMPACT_AUTO_TOKENS` (150000; `0` turns it
  off). A failed automatic compaction is not retried on the same session.
- Manual: the Compact button next to the context meter of the selected
  planner or implementor, or `POST /api/lines/:id/compact` and
  `POST /api/protocol/workers/:id/compact` (idle sessions only).

## Production lines

Clicking "Create new line" adds a standing-by "Draft line" (work directory under
`lines/`, git-initialized) and selects it. The first prompt typed into the line
is the initial prompt: the router wraps it in the planner brief and sends it to
a headless Vibe run (`vibe --workdir ... --trust --agent accept-edits --output
streaming`). The first run yields a `sessionId`; every later prompt is sent with
`--resume <sessionId>`, so each line is one long-lived, stateful Vibe
conversation.

## Factory protocol

Each line is a graph: a planner (the line's Vibe session) plus the implementor
workers it spawns. On creation the planner writes `plan.md` (markdown, including
a mermaid diagram of the task graph) in its workdir and waits. A human reviews
the plan in the UI and either sends feedback through the line's prompt input
(while a plan is proposed and unapproved, every prompt is plan feedback; the
planner revises `plan.md`) or approves it. The router blocks worker spawning
until approval.

On approval the planner spawns workers by calling the router's protocol API
(agents reach it with curl from bash):

- `POST /api/protocol/lines/:id/workers {name, persona, repo, prompt, base?}` —
  **deprecated**; use `POST /api/protocol/lines/:id/interactions/start {to: "backend-impl", name, task, repo, base?}`
  (see Interactions API). Spawn a
  worker (role implementor). Optional `base` is a full 40-character commit SHA
  or the name of a non-running implementor of the same line and repo (its
  branch head, `origin/<branch>` first, is used). The worktree starts there;
  the response and `GET .../workers` show `base` and `baseResolved`
  (`{kind, sha, ref}`). Errors: 404 unknown, 400 malformed or other repo,
  409 running. A stack child uses its parent's validated implementor name or
  head SHA as `base`; its draft PR base is the parent's branch. Persona: `backend` (architecture, data, APIs,
  logic — the default) or `frontend` (UI, pages, interaction); the persona
  selects the worker's brief (priorities and verification approach), and the
  validator spawned after the implementor inherits the same persona with the
  matching validation focus (frontend validators run headless UI tests with
  the playwright tools). The required `repo` field names the one registered
  repository the worker works in (400 without it - there is no default). 409 before
  plan approval, on a duplicate worker name, or with 8 workers/validators
  already RUNNING concurrently - the cap counts running implementors and
  validators together, never finished ones (large pipelines with many
  completed workers are fine); 404 for an
  unregistered repo name. Each worker runs in its own
  git worktree of its repo (`lines/worktrees/<lineId>/<repo>/<name>`) on
  branch `<lineIdPrefix>/<name>`, with no shared
  context with the planner: worker prompts must be self-contained.
- `GET /api/protocol/lines/:id/repos` / `POST /api/protocol/lines/:id/repos
  {name?, url}` — the line's repository registry. A line works across several
  repositories, and none of them is special: the line workdir holds only the
  planner state (`line.json`, `plan.md`) and is never a code repository.
  Every repository is registered by name (default: derived from the URL) and
  cloned under `lines/<lineId>/repos/<name>`. Each implementor and validator
  works on exactly one repository, one branch, and one worktree; the planner
  coordinates work that spans repositories. Lines saved before this rule
  adopt their workdir clone in place as a named repository (named after its
  remote, or `workdir`) the first time they load. Remotes are resolved at spawn time
  (`git remote get-url origin`), so an origin the planner added later is
  still detected.
- `GET /api/protocol/lines/:id/workers` — worker statuses, including role
  (implementor/validator) and which implementor a validator validates
  (planner polling fallback).
- `POST /api/protocol/workers/:id/stop` — stop a worker; the planner is woken
  with a WORKER STOPPED prompt (or VALIDATOR STOPPED for validators).
- `POST /api/protocol/workers/:id/remove` — remove a stopped/failed worker
  from the line: frees its name and branch for reuse, cascades to its
  finished validators, and (for implementors and integration validators)
  deletes its worktree and branch - the local work is discarded, pushed
  branches stay on the remote. 409 while the worker (or a validator of it)
  is still running. The planner brief documents the command and the
  semantics.
- `POST /api/protocol/workers/:id/continue {prompt}` — **deprecated**; use
  `POST /api/protocol/lines/:id/interactions/feedback {instance: "<id>", instructions}`.
  Resume the ORIGINAL
  implementor session in its worktree with follow-up instructions. 404 unknown
  worker; 409 for validators, while the worker is running, or before it has a
  session. When the continued run finishes, the report and validation loop run
  again as usual.
- `GET /api/protocol/workers/:id/port` — idempotent per-worker port allocation
  (base `UI_PORT_BASE`, default 4100). Frontend workers serve their app on this
  port (directly or in a docker container with `-p <port>:<containerPort>`) and
  record it in `ui.port`; frontend validators read it to reach the app.
- `POST /api/protocol/workers/:id/uitest` / `.../uitest/release` — UI test
  slot semaphore (`UI_TEST_SLOTS`, default 1). Acquire long-polls up to 120 s
  while other validators hold slots (408 on timeout); release is idempotent;
  slots auto-release when a worker stops. Only running workers can acquire.
  Validators that cannot acquire a slot are told to prefer parallel-safe
  scenarios instead: unique ports, isolated containers or headless browsers,
  no shared fixtures. Each worker session has its own playwright MCP server
  and therefore its own browser.

### Interactions API

The planner talks to its pipeline through interactions. The old routes
`/workers`, `/continue` and `/integration` are deprecated aliases for the
`default` pipeline (see below).

- `POST /api/protocol/lines/:id/interactions/:name {to, ...fields}` — the one
  call for every request-triggered interaction. For interactions whose target
  is `chosen` (for example `feedback` and `accept`), `instance` replaces
  `to`. The `start` interaction answers 201 `{instance: {...}}`; `feedback`
  answers 202 `{queued, compacting}`. 404 for an unknown line, interaction,
  node or instance; 403 `NO_EDGE` when the pipeline has no edge from the
  planner to that node for that interaction; 409 before plan approval.
- `GET /api/protocol/lines/:id/interactions` — what the planner may do, with
  the field list of every call.
- A call with missing, invalid or unexpected fields answers 400:

```json
{ "error": "start of node 'B' is incomplete: fill every listed field",
  "code": "INTERACTION_FIELDS", "interaction": "start", "to": "B",
  "missing": [{ "field": "task", "description": "...", "requiredBy": "..." }],
  "invalid": [{ "field": "task", "reason": "longer than 20000 characters" }],
  "unexpected": ["persona"],
  "expected": { "task": "text, required" } }
```

- `accept` records that the planner accepts the latest finished run of an
  instance: `POST .../interactions/accept {instance, reason}` answers 200
  `{accepted, instance, runId}`, or 409 while the instance is running.

Deprecated aliases. Every response of these three routes (success and error)
carries `Deprecation: true` and a `Link` header with
`rel="successor-version"` that points to the interactions route. Request
validation, response bodies and status codes stay as before.

| Old call | New call |
|---|---|
| `POST /api/protocol/lines/:id/workers {name, persona, repo, prompt, base?}` | `POST .../interactions/start {to: "backend-impl" or "frontend-impl", name, task, repo, base?}` |
| `POST /api/protocol/workers/:id/continue {prompt}` | `POST .../interactions/feedback {instance, instructions}` |
| `POST /api/protocol/lines/:id/integration {prompt}` | `POST .../interactions/start {to: "integration", instructions}` |

A line whose pipeline has no matching node or edge answers the old routes with
409 `this pipeline does not support <route>; use POST /api/protocol/lines/:id/interactions/<name>`.

### Container lifecycle

Every stage labels its containers: workers set both
`--label cuck.line=<lineId> --label cuck.worker=<workerId>`, the planner sets
`--label cuck.line=<lineId>`. Stages register background processes that
outlive their commands: `POST /api/protocol/lines/:id/inventory` with
`{kind: "process", pid, name}`.

When the project depends on docker itself (compose, image builds, nested
containers), stages give the container docker-in-docker capability instead of
sharing the host daemon socket:

```
docker run -d --privileged --label cuck.line=... --label cuck.worker=... --name <name>-dind docker:27-dind
```

Wait for the inner daemon (docker exec <name>-dind docker info), then run the
docker work inside with docker exec. Everything started inside the dind
container dies with the labeled parent when the router removes it, and the
router removes labeled containers with -v, so their anonymous volumes (the
DinD image declares VOLUME /var/lib/docker) do not leak disk space. A
--privileged container is NOT a security boundary - use it for trusted
project code only. Mounting the host docker socket is forbidden: containers
started through a shared socket escape the label-based cleanup.

Nothing survives unless the user asks: each
line keeps an inventory of its processes and containers (containers are
auto-discovered from the labels; the UI panel shows every item with a keep
toggle and a Kill button, plus Kill-all). Worker close, planner run close,
and line deletion kill their items — skipping only items the user marked
keep, which survive stage end and line deletion. Stage cleanup matches the
EXACT `cuck.worker` owner label: a container carrying only `cuck.line` (no
worker label) has unknown ownership and is never reaped by a stage — it dies
with the line deletion. Every reap is logged (`docker.reap`). A router
restart does NOT purge: it only removes orphans (containers labeled for
lines that no longer exist); containers of restored lines stay alive and
remain in the inventory. Registered processes are not swept on restart (a
pid may have been reused).

`DELETE /api/lines/:id` (two-step Delete button in the UI) kills the planner
and all running workers, releases their UI test slots, closes their SSE
streams, removes the line's workdir and worktrees, and cleans the inventory
per the keep rule. Unlabeled containers are never touched.

Planner-to-worker prompts and worker reports use ASD-STE100 Simplified
Technical English (the router injects the rule into both briefs): approved
words only, short sentences, one topic per sentence, imperative numbered
steps for procedures, active voice, no idioms or jargon.

### Validation loop

When an implementor finishes, the router wakes the planner with the
IMPLEMENTOR REPORT (the `report` interaction of the pipeline). The report tells
the planner to start a validator with acceptance criteria, or to accept the
work. Both are explicit calls to the interactions API; the router no longer
reads the criteria from the planner's reply:

- `POST /api/protocol/lines/:id/interactions/start {to: "<validator node>",
  criteria, source: "<implementor id>"}` starts a VALIDATOR. `source` must be
  an idle instance of a node that the validator node `checks` (in the `default`
  pipeline `backend-val` checks `backend-impl`, and `frontend-val` checks
  `frontend-impl`); `criteria` is a numbered list. The call is checked like
  every other call (see "Strict calls").
- `POST /api/protocol/lines/:id/interactions/accept {instance, reason}`
  accepts the latest run of an instance without a check. It replaces the old
  `SKIP VALIDATION` reply, and the integration rule counts it like a `PASS`.

The validator is a fresh session, running in the implementor's worktree (no new
worktree, no new branch), with a brief containing the implementor's report and
the criteria; its harness and model come from the node settings of the validator
node (by default the full-effort model). The validator checks the work — it may
run the code, the unit tests, and headless UI tests through the playwright
browser tools — and replies with a VALIDATION REPORT ending in `VERDICT: PASS`
or `VERDICT: FAIL`. The router wakes the planner with that report, and the
planner decides: accept the work, send follow-up instructions to the original
implementor session through the `feedback` interaction (the implementor keeps
its session memory and worktree, and validation repeats after it finishes
again), or start a new implementor.

A planner request that already waits for criteria when the router is updated
keeps the old flow once: the router reads the criteria (or `SKIP VALIDATION`)
from the reply. New implementor reports use the explicit calls only.

Validators are never resumed: each validation is a fresh session by
construction, so no validator state can pollute later runs. A second
validation of the same implementor gets a deduplicated validator name
(`validator-<name>`, `validator-<name>-2`, ...).

### Change-set limit (implementors)

The router enforces a 500-line limit on every implementor change set. When a
worker worktree is created, the router records its HEAD as the `baseCommit` (the
resolved `base` when the spawn gave one, so a stacked child does not recount
its parent's lines);
the base stays fixed across continued runs and router restarts. After each
successful implementor run — and again immediately before a validator is
created, as a stale-state defense — the router runs `git diff --numstat` from
the base commit to the branch HEAD and counts additions plus deletions over
code, tests, documentation, and configuration. Totals up to 500 pass; 501 or
more are rejected. A numstat row is binary only when BOTH count columns are
dashes; one dash plus one number is malformed. Binary files, dirty worktree
changes, and untracked files cannot bypass the limit: they escalate too. A
malformed non-empty numstat row, a failed git command, or a missing commit
makes the change set uncountable, which escalates as well; the result reports
only the offending lines, never unrelated command output, and keeps the
resolved HEAD. An oversized or uncountable change set never reaches the
validation handoff: the router does not request criteria and does not spawn a
validator, and instead wakes the planner with `CHANGESET LIMIT EXCEEDED`
(worker and session IDs, base and head commits, additions, deletions, total,
binary/dirty/untracked paths, and per-file values). The implementor session
and worktree are preserved for the `feedback` interaction: the planner can
continue the original session to reduce or split the work. The base commit
and the limit rule are part of the implementor brief; the latest result is
persisted in `line.json` and exposed in the worker API responses
(`baseCommit`, `changeset`). The limit applies to implementors only.

### Test scope

Implementors and validators run UNIT TESTS only — they never run
integration tests. The CI pipelines of the repository run the
integration tests (on lines with a remote, the validator opens the
draft PR and waits for CI, so integration failures still gate the
loop). Only the integration validator runs integration tests locally.

### Concurrency

The cap of 8 counts concurrently RUNNING implementors and validators
together — never finished, stopped, or failed workers, which stay in
the line's history (implementors are only removed explicitly). A
router-driven validator that would exceed the cap is deferred: it is
queued per line (`pendingValidations` in `line.json`), spawns
automatically when a worker closes, and survives restarts. The
planner-driven spawns (workers, integration validator) get a 409 and
the planner brief tells the planner to wait for completions and retry.

A deferred validation stays queued while its implementor is running. Each flush
checks at most the items that were queued at the start of that pass. It rotates
blocked items so ready validations can use free capacity. Removing an
implementor removes its pending validations and records that cancellation.
Each queued item stores its criteria, report, worker ID, invocation ID, and
run generation. A continuation advances that generation. If it changes the
work before a queued validation starts, the router cancels the old item with a
diagnostic. The new run needs new criteria. Planner request metadata, pending
validation metadata, and run generations persist in `line.json`.

### Worktree discipline

Every implementor works exclusively in its own git worktree of its assigned
repository and must never use the shared checkout of the line. Each
implementor reports the location of its worktree (`git rev-parse
--show-toplevel`) in its final report; the planner passes that location to
the validator, and the validator checks the work in that same worktree.

Independent tasks are spawned in parallel as parallel processes. Worker output
streams to the UI live, drawn as nodes connected to the planner node. When a
worker finishes (or fails, or is stopped), the router wakes the planner with
its report, and the planner decides what to do next: spawn follow-up workers,
restart a failed task under a new name, or conclude. The user can prompt the
planner at any time and stop any worker from the UI.

## Harness configuration

A line can configure, per node of its pipeline, which agent harness runs it and
with which model, effort level, and time limit (see "Pipeline settings"). The
environment variables and the code defaults are per phase (`planner`,
`implementor`, `validator`, `integration`); the phase of a node comes from its
type.

Supported harnesses: `vibe`, `pi`, `codex`, `claude`. Effort levels:
`low`, `medium`, `high`.

Precedence, most specific wins:

1. Code defaults: harness `vibe`; effort `medium`; models `glm-5-3-flash`
   (implementor) and `glm-5-3` (validator, integration); time limits
   `PLANNER_TIME_LIMIT` (planner) and `WORKER_TIME_LIMIT` (other phases).
   The default models are Vibe models: every other harness defaults to no
   model, and the router omits `--model` so the CLI uses its own default.
2. Environment variables, read at resolve time. Each applies to every node
   of its phase.
3. The settings in the node of the pipeline file (`harness`, `model`, ...).
4. The line settings: `nodeSettings.<node>` (set at line creation or with
   `PUT /api/lines/:id/pipeline`, persisted in `line.json`). A line that has
   no `nodeSettings`, only the old per-phase `pipeline` overrides, applies those
   overrides over the pipeline file settings.
5. A per-worker override: `harness`, `model`, and `effort` fields on the body of
   the deprecated `POST .../workers` call (they win over the node settings and
   are stored on the worker record).

Environment variables per phase (`PLANNER_`, `IMPLEMENTOR_`, `VALIDATOR_`,
`INTEGRATION_`): `<PHASE>_HARNESS`, `<PHASE>_MODEL`, `<PHASE>_EFFORT`.
`IMPLEMENTOR_MODEL` and `VALIDATOR_MODEL` keep their existing meaning.
A model id belongs to one harness: `<PHASE>_MODEL` applies only while the
phase runs the env/default harness. A line or worker that switches the
phase to another harness without naming a model gets that harness's
default, never a model id meant for a different CLI.
`VIBE_MODELS` is a comma-separated list of extra Vibe model choices offered
in the UI (empty values are ignored); it does not change the resolved
`pipeline.<phase>.model`, which stays a plain string. `authMode` is never
saved in the pipeline.

Example settings on `POST /api/lines` (node ids of the `default` pipeline):

```json
{
  "name": "my line",
  "pipelineName": "default",
  "nodeSettings": {
    "backend-impl": { "harness": "pi", "model": "glm-5-3-flash", "effort": "high" },
    "backend-val": { "harness": "vibe", "timeLimit": 900 }
  }
}
```

The old per-phase shape is still accepted: `"pipeline": {"implementor": {...},
"validator": {...}}` sets the same settings on every node of that phase.

`GET /api/harnesses` probes every harness (version and auth commands, 2 s
timeout each) and returns `{ harnesses: [...], probedAt }`. Results are
cached for 30 seconds; `?refresh=1` skips the cache. Per harness it reports
`installed`, `auth` (`ok`, `missing`, or `unknown`), `version`, and
`loginHint`. The `vibe` entry also carries `models`: a deduplicated
`[{value, label}]` list built from the code defaults, the per-phase
`<PHASE>_MODEL` env values, `VIBE_ACTIVE_MODEL`, and `VIBE_MODELS`
(a comma-separated list of extra model ids; empty values are ignored).
The `claude` entry also carries `models`. It reads exactly three local JSON
files: `~/.claude/settings.json`, `~/.claude/settings.local.json`, and
`~/.claude/cache/gateway-models.json`. Choices appear in this order: aliases,
settings options, local settings options, then gateway models. Duplicate model
values are removed. A gateway row is removed when its display label matches a
picker label. Invalid or missing files contribute no rows. Claude environment
model values are ignored, and no network access occurs. Rows use only `value`
and `label`; picker fields use `model` and optional `label`, while gateway
fields use `id` and optional `display_name`. The list has at most 100 rows.
Its `auth` comes from `claude auth status`.
The `pi` entry carries `authModes` (`[{value, label}]`, the providers
discovered from `pi --list-models`) and provider-qualified `models`
(`value` is `provider/model`). A failed `pi --list-models` command yields
no providers and no models; error output never becomes a catalog row. pi
has no provider-free auth check: its
base `auth` stays `unknown` because the auth state depends on the
provider. Creating a line or spawning a worker with a harness that is not
installed fails with 400.

`GET /api/harnesses/pi?provider=<provider>` returns the pi detail for one
provider: `{ id: "pi", authMode, auth, loginHint, models }`, where `auth`
is `ok`, `missing`, or `unknown`, and `models` are the provider-qualified
choices (`provider/model`). The provider is validated against the
discovered provider list; a missing or unknown provider returns 400 with a
clear error. The auth check runs `pi auth check --provider <provider>
--json` per request (never cached, one provider's result never serves
another) and only the auth state, login hint, and model choices are
returned — never credentials or raw command output.

### How the router starts a phase

1. It resolves the phase config and creates one adapter per child process
   with `createHarness(harness)`.
2. `buildRun()` produces `{ cmd, args, env, cwd }`; `env` holds only extra
   variables and is merged over `process.env`.
3. Each stdout JSON line goes through `normalize()`; the returned entry
   lands in the transcript and carries the captured session id.
4. At close, `finalize()` flushes a partial message, then `outcome()`
   maps the exit to `ok`, `timeout`, or `fail`.
5. `vibe` enforces its time limit itself; for `pi`, `codex`, and `claude`
   the router starts a kill timer that sends `SIGTERM`.

`claude` runs headless as `claude -p --output-format stream-json --verbose
[--model <model>] --dangerously-skip-permissions --effort <level> --
<prompt>` in the stage workdir, with `--resume <sessionId>` on later turns
and the planner policy through `--append-system-prompt-file`. The prompt
comes last, after `--`: the planner turn wrapper starts with `---`, which
the CLI would otherwise reject as an unknown option. The router effort
levels map 1:1 to Claude Code's `--effort`. The session runs with the
user's own Claude Code settings, so MCP servers (for example playwright for
frontend validators) come from that configuration.

Login hints per harness: `vibe --setup`; `pi /login` (in the pi TUI);
`codex login`; `claude login`.

### Failure reporting

Planner and worker runs report a failure the same way for every harness
(`run-failure.js`). The message names the command and how it ended (not
found on PATH, time limit, signal, or exit code), then the error the
harness reported on its own stream, then stderr. Stream errors are
collected by the adapters and never become assistant text or a report:
claude API error messages (`is_api_error_message`) and results with
`is_error` (which also fail a run that exits 0), pi `message_end` with
`stopReason: "error"`, and codex `error` / `turn.failed` events. vibe
reports failures through its exit code and stderr. stderr keeps its first
and last part, so an echoed argument cannot push the error out.

A planner failure goes to the line's error banner (click to dismiss). A
worker failure is stored on the worker as `lastError` (persisted, and
listed by the workers API), shown in the banner, the worker node tooltip,
and the worker view, and appended to the planner wake prompt as
`FAILURE DETAIL`. Runs that cannot start no longer crash the router.

## Work registry (cross-line coordination)

The registry lets lines see each other's work. It avoids duplicate work between planners.

### Purpose and trust boundary
- One local router process serves the registry. One writer changes the data.
- The acting line is the `:lineId` segment in the write path. The router does not authenticate it.
- There is no multi-user authentication. Any local client can name any line.
- The data stays in local storage. The router sends nothing to a remote service.
- A write route returns 404 `UNKNOWN_LINE` when the line does not exist.

### Concepts
- **Claim.** One line announces material work. Fields: `title`, `summary`, `tags` (20 at most), `repo`, `branch`, `commit` (40 hex characters), `contract`. The router sets `id`, `ownerLineId`, `revision` and the times.
- **Statuses.** There are six: `planned`, `active`, `available`, `superseded`, `stale`, `merged`.
- **Who sets a status.** The owner sets `planned`, `active`, `available` and `superseded`. Only the router sets `stale` and `merged`. An owner who sets them gets 403 `FORBIDDEN_STATUS`.
- **Current statuses.** `planned`, `active` and `available` are current. Lists show only current claims unless `status` says otherwise.
- **Renew.** The owner confirms a claim again. A stale claim returns to `active` unless the owner gives a current status.
- **Supersede.** The owner replaces a claim. It can name the new claim in `byClaimId`. A superseded or merged claim cannot change (409 `TERMINAL`).
- **Revisions.** Each change needs `expectedRevision`. A wrong value gives 409 `STALE_REVISION` with `currentRevision`.
- **Stale rules.** The router marks a current claim stale for one reason:
  - `owner-gone`: the owner line was deleted.
  - `branch-missing`: the branch is missing on the remote more than 24 hours after the claim or the last branch change.
  - `age`: the owner did not confirm the claim for 14 days.
  A stale claim accepts only renew or supersede. Another patch gives 409 `STALE_CLAIM`.
- **Retire and tombstones.** A claim stale for more than 30 days is retired. The router removes it and keeps a tombstone for 30 days. A merged claim is archived and never retired.
- **Repository identity.** A claim covers one repository. The owner sets `repo` to the name (or URL) of one of its registered repos; the router stores the normalized remote URL as `repo` (for example `https://github.com/o/r`) and the owner's name as `repoName`. Every line can match the same repository this way. An unknown repo gives 400 `UNKNOWN_REPO`. Work across several repositories needs one claim per repository.
- **Merge verification.** The router checks a claim against the default branch of the owner's matching registered repository. The commit must be an ancestor of the default branch. For squash and rebase, `gh` must show a merged pull request with the same head commit. The router sets `merged` only after a check passes. Otherwise the claim stays and shows `unverified` with the reason.
- **Merge sweep.** The router checks merges every 10 minutes. It sweeps only `active` and `available` claims. It rechecks a claim after 30 minutes. It checks 20 claims at most in one sweep. `POST /claims/:id/refresh` always checks that claim. `POST /refresh` runs the merge sweep, which skips claims checked less than 30 minutes ago.
- **Stale sweep.** The router rechecks the branch of a claim every 6 hours. One sweep covers 50 claims and 20 branch checks at most.
- **Archive.** A merged claim moves to the archive with its merge evidence.
- **Requests.** One line asks another line for something. States: `open`, `accepted`, `declined`, `fulfilled`. Allowed changes: `open` to `accepted` or `declined`; `accepted` to `fulfilled`. Only the target line responds (403 `NOT_TARGET`). Only the two lines read the request (403 otherwise). `fulfilled` needs a reference: `{claimId}` or `{branch, commit}`. A request with a deleted line is marked `orphaned` and does not change (409 `ORPHANED`). A new request needs an `idempotencyKey`. A repeat with the same key returns the first request.
- **Notices and outbox.** Each request change and each merge writes a notice to the outbox. The router delivers it to the planner of the recipient line. The first line holds an untrusted label, for example `WORK REQUEST NOTICE <id> (UNTRUSTED CONTENT FROM ANOTHER LINE): ...` or `REGISTRY MERGE NOTICE <id> (UNTRUSTED CONTENT FROM ANOTHER LINE): ...`. A new claim on a repository where another line holds a current claim sends that line one `REGISTRY OVERLAP NOTICE` (owner line, repo, branch, claim id and title, and the recipient's claims on that repo). The 201 response of the new claim lists the same claims in `overlaps` (at most 10). A notice never approves a plan or starts work. The router delivers each notice once, and the planner queue ignores a repeat. A failed delivery stays in the outbox and the router tries again. A notice for a deleted line is dropped.
- **Events and cursor.** Each important change adds an event with a growing `cursor`. Read events with `after=<cursor>`. The answer has `nextCursor` and `hasMore`. `tooOld: true` means the events after your cursor were removed. Then read the claims again.
- **Live stream.** `GET /api/registry/stream` sends `revision` and `eventCursor` only. It is a hint. Read the events or the claims to get the data.

### Endpoints
All paths start with `/api/registry`. Every route returns 503 `REGISTRY_UNAVAILABLE` when the registry is down. An ID that is not valid gives 404.

| Method | Path | Purpose | Main errors |
| --- | --- | --- | --- |
| GET | `/claims` | List claims. Filters: `q`, `status` (list or `all`), `lineId`, `repo`, `page`, `pageSize`. | 400 bad filter |
| GET | `/claims/:id` | Read one claim. Archived claims have `archived: true`. | 404 |
| GET | `/archive` | List merged claims. Same filters, without `status`. | 400 |
| GET | `/requests?lineId=` | List requests of one line. Filters: `state`, `q`, paging. | 400 no `lineId` |
| GET | `/requests/:id?lineId=` | Read one request. | 400, 403, 404 |
| GET | `/events?after=&limit=` | Read events after a cursor. | 400 bad number |
| GET | `/summary` | Fields: `claimsByStatus`, `claimsByOwner`, `claimsByRepo`, `requestsByState`, `archiveCount`, `snapshotRevision`, `eventCursor`. | none |
| GET | `/stream` | Server-sent events with revision hints. | 503 `STREAM_LIMIT`, 503 `REGISTRY_UNAVAILABLE` |
| POST | `/lines/:lineId/claims` | Create a claim. `idempotencyKey` is optional. | 400, 403, 409 |
| PATCH | `/lines/:lineId/claims/:id` | Change a claim. | 400, 403, 409 |
| POST | `/lines/:lineId/claims/:id/renew` | Renew a claim. | 403, 404, 409 |
| POST | `/lines/:lineId/claims/:id/supersede` | Supersede a claim. | 403, 404, 409 |
| POST | `/lines/:lineId/requests` | Open a request. | 400, 404, 409 |
| PATCH | `/lines/:lineId/requests/:id` | Accept, decline or fulfil. Body: `state`, `expectedRevision`, `reference`. | 400, 403, 409 |
| POST | `/refresh` | Run the merge sweep now. 202 if a run is active. | 400 `FORBIDDEN_FIELD`, 400 `INVALID_JSON`, 400 `BODY_TOO_LARGE` |
| POST | `/claims/:id/refresh` | Check one claim for a merge now. | 400 `FORBIDDEN_FIELD`, 400 `INVALID_JSON`, 400 `BODY_TOO_LARGE`, 404 |
| POST | `/staleness/sweep` | Run the stale sweep now. 202 if a run is active. | 500 |

### Storage and operations
- **File.** `LINES_DIR/work-coordination.json`.
- **Writes.** The router writes a temporary file and renames it. One transaction runs at a time.
- **Corrupt file.** The router loads the file at start. If the file is corrupt, it answers 503 on all registry routes. It never overwrites the file. Fix or remove the file, then restart the router.
- **Retention.** The router keeps the archive, events, delivered notices and tombstones for 30 days.
- **Schedules.** Delivery runs every 30 seconds. The stale and merge sweeps run every 10 minutes. The first sweep runs 60 seconds after start.
- **Limits.** Page size: 100 at most (default 20). Request body: 64 KB. Stream clients: 100. Search `q`: 200 characters.

### Known limitations
- One router only. Two routers on one directory are not supported.
- If the registry is unavailable, a restart is needed after the fix.
- Stale checks need git access to the repository registered for the owner line.
- Squash and rebase detection needs the `gh` tool.

## Limitations

Single user, no authentication, and prompts on a line execute strictly one at
a time. Plan approval is a router-side gate only — the router blocks worker
spawning until a human approves, but does not check the plan's content. The
validation loop trusts the planner's criteria and the validator's verdict;
the router does not interpret the report beyond the final `VERDICT:` line.
Lines (id, name, session, planApproved, worker list with role and validates)
persist to `lines/<id>/line.json` and are rehydrated on restart; transcripts
are in memory and do not survive a restart; workers that were running when the
router stopped come back as "stopped", and a validator whose implementor is
missing is dropped on restore.

## Security

Lines run with `--auto-approve`: a headless process has no one to answer
approval prompts, so every tool call (including `git push`, `gh`, file
deletion) runs without asking. Set `LINE_AUTO_APPROVE=0` to run lines under
`--agent accept-edits` instead — side-effecting commands will then be denied,
not queued.

## Logging

Everything is logged as JSON lines to `logs/router.log`: every HTTP request
and response (method, path, status, duration), planner runs (start, streamed
entries, end with exit code and duration), decisions (validation skip vs
spawn, wake retries and drops), worker lifecycle (spawn, run start, entries,
close with report), validators, UI slot acquire/release, port assignment,
inventory (discovery, registration, keep, kills), docker cleanups with
counts, SSE connections, and server boot/shutdown. Warnings and errors are
mirrored to stdout.

Log rotation: when `router.log` would exceed `LOG_MAX_BYTES` (default 1 MB),
it rotates to `router.log.1`, shifting older files up to `LOG_KEEP` (default
5) backups. Entries carry `t` (ISO timestamp), `level`, `event`, and
event-specific fields; prompt/report text is previewed with a length cap.

## Remote pipeline (lines with a repository)

Create a line with its repositories to work on a real project:
`POST /api/lines {"name": "...", "repos": [{"name": "web", "url": "<git URL>"}, ...]}`
clones each repository under `lines/<lineId>/repos/<name>`. `{"repoUrl": "<git URL>"}`
is a shorthand for one repository named after its URL. The planner can register
more repositories later. The router accepts `https://`, `ssh://`,
and `user@host:path` URLs. Set `ROUTER_ALLOW_LOCAL_REPOS=1` to also accept
local paths and `file://` URLs. The pipeline then extends past validation:

- Implementors commit in their worktree branch and push it to the remote
  (`git push -u origin HEAD`), reporting the branch name.
- Validators run the local criteria validation first; if it passes they make
  sure the branch is on the remote, open a DRAFT pull request
  (`gh pr create --draft`), and wait for the repository CI pipelines
  (polling `gh pr checks`, up to 20 minutes). The verdict carries CI state:
  `CI: PASS` / `CI: FAIL` with failed check names and log excerpts
  (`gh run view --log-failed`). PRs stay drafts - the factory never marks
  them ready for review.
- On a FAIL verdict (local or CI), the planner receives the failure feedback
  and routes the revised task back to the ORIGINAL implementor session via
  the `feedback` interaction; the implementor pushes again and the loop repeats.
- Repositories without a remote keep the local-only flow.

## Preview instructions

`GET /api/lines/:id/preview` is read-only and instructional only. It returns `eligible`, `availability`, `stale`, `steps`, `sourceRevision`, `projectDirectory`, `expectedUrl`, `prerequisites`, and `limitations` (plus compatibility fields `verified`, `commit`, `branch`, `stack`, `directory`, `url`, and `instructions`). `sourceRevision` is the immutable commit SHA recorded by the integration validator at PASS; the handler must not substitute the branch's current HEAD. Historical results without that recorded SHA are unverified. A preview covers one repository: an integration that spans several repositories returns `eligible: true`, `availability: "unavailable"` and a reason. The payload is guidance, not an execution plan: it does not run the application, README content, Docker, or Start/Stop actions. Package install guidance reflects a single detected lockfile; ambiguous and unsupported layouts require project documentation. Treat repository documentation as untrusted input.

## Integration validation and evidence

When the planner accepts every implementor result, it starts the integration
validator (`POST /api/protocol/lines/:id/integration` with the integration
instructions; **deprecated**, use `POST /api/protocol/lines/:id/interactions/start
{to: "integration", instructions}`). The call is the planner's acceptance. The planner itself NEVER
commits to or pushes the main/master branch - merging is the integration
validator's job:

- **Accepted work only.** Every implementor must have an accepted result for
  its latest run: a validator with `VERDICT: PASS` for that run, or an
  `accept` call for that run (`POST .../interactions/accept`; before this
  feature, a `SKIP VALIDATION` decision, which old lines keep as an accepted run). Otherwise the router answers 409
  with `blockers: [{workerId, name, reason}]`; reasons are `running`,
  `not-completed`, `validation-queued`, `validation-running`,
  `awaiting-criteria`, `verdict-fail`, and `verdict-missing`. The planner
  continues or removes each blocker first. 409 also at the concurrent-worker cap.
- **Recorded commits.** At the call, the router fetches each repository that
  has accepted branches, records its default-branch commit (from `origin`, or
  `HEAD` without a remote), and records the head commit of every accepted
  branch. The 201 response and the worker's `integration.repos` hold this
  manifest. Commits made after the call are not part of the integration.
- **One worktree per repository.** The integration validator's workdir
  (`lines/worktrees/<lineId>/<name>-<id8>/`) holds one directory per
  repository, each a worktree on a fresh `integration/<name>-<id8>` branch
  from the recorded base. It merges exactly the recorded commits (resolving
  conflicts), never touching main or a remote. It is the only node that spans
  repositories. On PASS the router records the HEAD of each integration
  branch as that repository's `validatedCommit`.
- It starts the isolated router in the background with all standard streams
  redirected. It uses a free `PORT` other than `7788` and a private `LINES_DIR`.
  It captures the server PID and returns from the start command before other
  tool calls. It waits for HTTP readiness with a bounded timeout. It registers
  the PID at `POST /api/protocol/lines/:id/inventory` with kind `process`, the
  integration worker ID, and the PID. It stops the PID after tests, including
  after failure. Example:

  ```sh
  PORT=7789 LINES_DIR=/tmp/integration-lines node router-prototype/server.js \
    >router.log 2>&1 & SERVER_PID=$!; echo "$SERVER_PID"
  ```

- It runs all acceptance tests, then records one complete showcase for the
  integration attempt. It uses one browser context and one continuous WebM.
  It captures PNG or JPEG screenshots for significant steps in demonstration
  order. Each screenshot stays paired with its matching title and
  explanation. It closes the context before registration. It registers the
  versioned request `{kind: 'showcase', version: 1, useCase, file, steps:
  [{title, explanation, screenshot}]}` with the worker evidence endpoint.
  All media paths are relative to the workdir. Accepted API revision:
  `362eff17942182a62baf05ef12423afa2dbf6613`. POST returns
  `{evidenceId, attemptId}`. GET returns `{items, history, currentAttemptId,
  currentAttemptIds}`. The router owns attempt identity.
  Each record in `items` and `history` has `addedBy: {id, name, role}`.
  `role` is `integration validator`, `validator`, `implementor`, or null.
  The router stores the name and role at registration, so they stay correct
  after the worker is removed. For old records it reads the live worker, and
  gives null name and role if the worker is gone. `at` is epoch milliseconds.
  Both lists are sorted by `at`, newest first.
  It reports capture and registration failures. It does not replace a failed
  showcase with short clips. It restarts the router after an API change.

- Its INTEGRATION REPORT wakes the planner with the merged result branch, the
  per-branch conflict resolutions, and the verdict. On FAIL the planner routes
  fixes back to the ORIGINAL implementors and starts a fresh integration
  validator afterwards.
- In the UI, clicking a validator node reveals an Evidence tab in the line
  toolbar; it lists every tested use case with the video recording underneath,
  streamed from `GET /api/lines/:id/evidence/:id/video`.

### Where videos live and how they stream

- Each evidence video is recorded by the integration validator inside its own
  worktree: `router-prototype/lines/worktrees/<lineId>/integration-validator-<id8>/evidence/*.webm`
  (the worker's workdir). The absolute file path is stored in
  `lines/<lineId>/line.json`, so evidence survives restarts as long as the
  worktree is not deleted.
- The router streams the file from disk with HTTP range support
  (`Accept-Ranges: bytes`, `206 Partial Content`, `416` for invalid ranges),
  which browsers require for video seeking and streaming.
- The evidence registration endpoint rejects unfinalized recordings
  (0-byte or <1 KB files). A WebM is only playable after the browser
  context that recorded it is closed. The integration brief requires this.
  It requires explicit capture and registration failure reports. It does
  not replace a failed showcase with short clips. Restart the router after
  an API change when the running process has an older version.
- Integration workers, their branches, and evidence items persist across
  restarts.

The graph renders four tiers: planner -> implementors -> validators ->
integration validators. When a validator or integration validator pushes
back on a change (VERDICT: FAIL in its report), the router records the
verdict and the node renders in an amber "issue found" state - visually
distinct from the red error state (a worker that crashed) and from green
completed. Verdicts persist across restarts.
