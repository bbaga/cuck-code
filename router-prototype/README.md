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

Then open http://localhost:7788. Configuration via env: `PORT` (default 7788),
`LINES_DIR` (default `./lines`), `IMPLEMENTOR_MODEL` (default `glm-5-3-flash`,
the fast model) and `VALIDATOR_MODEL` (default `glm-5-3`, the full-effort
model). The router pins each vibe session to its role's model via
`VIBE_ACTIVE_MODEL` in the spawn environment; planner runs inherit the ambient
config. Requires Node >= 18 and the `vibe` CLI on PATH.

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

- `POST /api/protocol/lines/:id/workers {name, persona, repo, prompt}` — spawn a
  worker (role implementor). Persona: `backend` (architecture, data, APIs,
  logic — the default) or `frontend` (UI, pages, interaction); the persona
  selects the worker's brief (priorities and verification approach), and the
  validator spawned after the implementor inherits the same persona with the
  matching validation focus (frontend validators run headless UI tests with
  the playwright tools). The optional `repo` field selects which of the
  line's repositories the worker works in (default `primary`). 409 before
  plan approval, on a duplicate worker name, or past the cap of 8 workers
  per line; 404 for an unregistered repo name. Each worker runs in its own
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
keep, which survive stage end and line deletion. A router restart sweeps and
removes every labeled container (including kept ones); registered processes
are not swept on restart (a pid may have been reused).

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

### Test scope

Implementors and validators run UNIT TESTS only — they never run
integration tests. The CI pipelines of the repository run the
integration tests (on lines with a remote, the validator opens the
draft PR and waits for CI, so integration failures still gate the
loop). Only the integration validator runs integration tests locally.

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

## Integration validation and evidence

When all implementor validators report VERDICT: PASS, the planner starts the
integration validator (`POST /api/protocol/lines/:id/integration` with the
integration instructions). The planner itself NEVER commits to or pushes the
main/master branch - merging is the integration validator's job:

- The integration validator gets its own worktree on a fresh
  `integration/<name>-<id>` branch created from main. It merges every feature
  branch there (resolving conflicts), never touching main or the remote.
  When the line works across several repositories, it makes its own local
  copies of the non-primary repos inside its workdir and merges their
  feature branches there the same way - never pushing to any remote.
- It runs all acceptance tests, and for EVERY use case records a video of the
  test running (playwright `video: 'on'`, files under `evidence/` in its
  workdir), registering each one with
  `POST /api/protocol/workers/:id/evidence {useCase, file}`.
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
  (0-byte or <1 KB files) - a webm is only playable after the browser
  context that recorded it is closed, so the integration brief instructs
  the worker to close the context BEFORE registering each video.
- Integration workers, their branches, and evidence items persist across
  restarts.

The graph renders four tiers: planner -> implementors -> validators ->
integration validators. When a validator or integration validator pushes
back on a change (VERDICT: FAIL in its report), the router records the
verdict and the node renders in an amber "issue found" state - visually
distinct from the red error state (a worker that crashed) and from green
completed. Verdicts persist across restarts.
