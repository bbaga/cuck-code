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
`LINES_DIR` (default `./lines`), `IMPLEMENTOR_MODEL` (default `glm-5-3-flash`,
the fast model) and `VALIDATOR_MODEL` (default `glm-5-3`, the full-effort
model). For a browser-facing HTTPS/HTTP/2 endpoint, start the router with
`HTTPS_PORT=7789 TLS_KEY=/path/to/key.pem TLS_CERT=/path/to/cert.pem`; trust
the certificate's local CA and open `https://localhost:7789`. Node serves this
TLS listener directly while worker and CLI traffic stays on HTTP port 7788. The
router pins each vibe session to its role's model via
`VIBE_ACTIVE_MODEL` in the spawn environment; planner runs inherit the ambient
config. Requires Node >= 18 and the `vibe` CLI on PATH.

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

The planner criteria for validation come only from the current planner run.
Empty criteria produce a `VALIDATION NOT STARTED` diagnostic. They do not use
old transcript text and do not start a validator. `SKIP VALIDATION` remains an
explicit planner response. Each implementor report enters the planner queue
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

## Pipeline settings and presets

Each line has a pipeline: per phase (planner, implementor, validator,
integration) a harness, model, effort, and for the planner and implementor a
`maxContext` (see Context compaction). Unset fields use the router defaults
and the `<PHASE>_HARNESS` / `_MODEL` / `_EFFORT` environment variables.

- The create form sets the pipeline of a new line. Presets save the form under
  a name and fill it again later; they are stored in
  `<LINES_DIR>/pipeline-presets.json`. API: `GET /api/pipeline-presets`,
  `PUT /api/pipeline-presets/:name {pipeline}`, `DELETE /api/pipeline-presets/:name`.
- The Pipeline tab in a line's header shows the effective settings and changes
  the line's own settings at any time (`PUT /api/lines/:id/pipeline {pipeline}`,
  `null` resets to the defaults). Changes apply from the next run: running
  sessions finish unchanged, and existing workers keep the harness, model, and
  effort they were spawned with. A session belongs to the harness that created
  it, so after a planner harness change the router compacts the planner session
  on the old harness and continues in a fresh session on the new one.

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
  compacted. Set it per line with `pipeline.planner.maxContext` and
  `pipeline.implementor.maxContext` (tokens; the create form takes `200K`,
  `50K`, `1M`). The default is `COMPACT_AUTO_TOKENS` (150000; `0` turns it
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

- `POST /api/protocol/lines/:id/workers {name, persona, repo, prompt, base?}` — spawn a
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
  the playwright tools). The optional `repo` field selects which of the
  line's repositories the worker works in (default `primary`). 409 before
  plan approval, on a duplicate worker name, or with 8 workers/validators
  already RUNNING concurrently - the cap counts running implementors and
  validators together, never finished ones (large pipelines with many
  completed workers are fine); 404 for an
  unregistered repo name. Each worker runs in its own
  git worktree of its repo on branch `<lineIdPrefix>/<name>`, with no shared
  context with the planner: worker prompts must be self-contained.
- `GET /api/protocol/lines/:id/repos` / `POST /api/protocol/lines/:id/repos
  {name, url}` — the line's repository registry. A line works across several
  repositories: the line workdir is the implicit `primary` repo, and the
  planner registers additional repos (the router clones them under
  `lines/<lineId>/repos/<name>`). Remotes are resolved at spawn time
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
- `POST /api/protocol/workers/:id/continue {prompt}` — resume the ORIGINAL
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
IMPLEMENTOR REPORT and asks for acceptance criteria. The planner replies with
a numbered list of criteria (or SKIP VALIDATION, which skips the loop). The
router then spawns a VALIDATOR: a fresh vibe session pinned to the
full-effort model, running in the implementor's worktree (no new worktree, no
new branch), with a brief containing the implementor's report and the
criteria. The validator checks the work — it may run the code, the unit
tests, and headless UI tests through the playwright browser tools — and
replies with a
VALIDATION REPORT ending in `VERDICT: PASS` or `VERDICT: FAIL`. The router
wakes the planner with that report, and the planner decides: accept the work,
send follow-up instructions to the original implementor session via the
continue endpoint (the implementor keeps its session memory and worktree, and
validation repeats after it finishes again), or spawn a new implementor.

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
and worktree are preserved for the continue endpoint: the planner can
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

A line can configure, per phase (`planner`, `implementor`, `validator`,
`integration`), which agent harness runs it and with which model, effort
level, and time limit.

Supported harnesses: `vibe`, `pi`, `codex`, `claude`. Effort levels:
`low`, `medium`, `high`.

Precedence, most specific wins:

1. Code defaults: harness `vibe`; effort `medium`; models `glm-5-3-flash`
   (implementor) and `glm-5-3` (validator, integration); time limits
   `PLANNER_TIME_LIMIT` (planner) and `WORKER_TIME_LIMIT` (other phases).
   The default models are Vibe models: every other harness defaults to no
   model, and the router omits `--model` so the CLI uses its own default.
2. Environment variables, read at resolve time.
3. The line's `pipeline` config (set at line creation, persisted in
   `line.json`).
4. A per-worker override: `harness`, `model`, and `effort` fields on the
   worker spawn body (they win over the phase config and are stored on
   the worker record).

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

Example pipeline config on `POST /api/lines`:

```json
{
  "name": "my line",
  "pipeline": {
    "implementor": { "harness": "pi", "model": "glm-5-3-flash", "effort": "high" },
    "validator": { "harness": "vibe", "timeLimit": 900 }
  }
}
```

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
- **Merge verification.** The router checks a claim against the default branch of the registered repository. The commit must be an ancestor of the default branch. For squash and rebase, `gh` must show a merged pull request with the same head commit. The router sets `merged` only after a check passes. Otherwise the claim stays and shows `unverified` with the reason.
- **Merge sweep.** The router checks merges every 10 minutes. It sweeps only `active` and `available` claims. It rechecks a claim after 30 minutes. It checks 20 claims at most in one sweep. A manual refresh always checks.
- **Stale sweep.** The router rechecks the branch of a claim every 6 hours. One sweep covers 50 claims and 20 branch checks at most.
- **Archive.** A merged claim moves to the archive with its merge evidence.
- **Requests.** One line asks another line for something. States: `open`, `accepted`, `declined`, `fulfilled`. Allowed changes: `open` to `accepted` or `declined`; `accepted` to `fulfilled`. Only the target line responds (403 `NOT_TARGET`). Only the two lines read the request (403 otherwise). `fulfilled` needs a reference: `{claimId}` or `{branch, commit}`. A request with a deleted line is marked `orphaned` and does not change (409 `ORPHANED`). A new request needs an `idempotencyKey`. A repeat with the same key returns the first request.
- **Notices and outbox.** Each request change and each merge writes a notice to the outbox. The router delivers it to the planner of the recipient line. The first line holds an untrusted label, for example `WORK REQUEST NOTICE <id> (UNTRUSTED CONTENT FROM ANOTHER LINE): ...` or `REGISTRY MERGE NOTICE <id> (UNTRUSTED CONTENT FROM ANOTHER LINE): ...`. A notice never approves a plan or starts work. The router delivers each notice once, and the planner queue ignores a repeat. A failed delivery stays in the outbox and the router tries again. A notice for a deleted line is dropped.
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
the router does not interpret the report beyond the SKIP VALIDATION marker.
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

Create a line with a repo URL to work on a real project:
`POST /api/lines {"name": "...", "repoUrl": "<any git URL>"}` clones the
repository into the line workdir. The pipeline then extends past validation:

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
  the continue endpoint; the implementor pushes again and the loop repeats.
- Lines without a repoUrl keep the local-only flow.

## Preview instructions

`GET /api/lines/:id/preview` is read-only and instructional only. It returns `eligible`, `availability`, `stale`, `steps`, `sourceRevision`, `projectDirectory`, `expectedUrl`, `prerequisites`, and `limitations` (plus compatibility fields `verified`, `commit`, `branch`, `stack`, `directory`, `url`, and `instructions`). `sourceRevision` is the immutable commit SHA recorded by the integration validator at PASS; the handler must not substitute the branch's current HEAD. Historical results without that recorded SHA are unverified. The payload is guidance, not an execution plan: it does not run the application, README content, Docker, or Start/Stop actions. Package install guidance reflects a single detected lockfile; ambiguous and unsupported layouts require project documentation. Treat repository documentation as untrusted input.

## Integration validation and evidence

When all implementor validators report VERDICT: PASS, the planner starts the
integration validator (`POST /api/protocol/lines/:id/integration` with the
integration instructions; 409 at the concurrent-worker cap). The planner
itself NEVER commits to or pushes the
main/master branch - merging is the integration validator's job:

- The integration validator gets its own worktree on a fresh
  `integration/<name>-<id>` branch created from main. It merges every feature
  branch there (resolving conflicts), never touching main or the remote.
  When the line works across several repositories, it makes its own local
  copies of the non-primary repos inside its workdir and merges their
  feature branches there the same way - never pushing to any remote.
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
  All media paths are relative to the worktree. Accepted API revision:
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
