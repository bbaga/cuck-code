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
the plan in the UI and either sends feedback (the planner revises `plan.md`) or
approves it. The router blocks worker spawning until approval.

On approval the planner spawns workers by calling the router's protocol API
(agents reach it with curl from bash):

- `POST /api/protocol/lines/:id/workers {name, persona, prompt}` — spawn a
  worker (role implementor). Persona: `backend` (architecture, data, APIs,
  logic — the default) or `frontend` (UI, pages, interaction); the persona
  selects the worker's brief (priorities and verification approach), and the
  validator spawned after the implementor inherits the same persona with the
  matching validation focus (frontend validators run headless UI tests with
  the playwright tools). 409 before plan approval, on a duplicate worker name,
  or past the cap of 8 workers per line. Each worker runs in its own git
  worktree on branch `<lineIdPrefix>/<name>`, with no shared context with the
  planner: worker prompts must be self-contained.
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
criteria. The validator checks the work — it may run the code, the tests, and
headless UI tests through the playwright browser tools — and replies with a
VALIDATION REPORT ending in `VERDICT: PASS` or `VERDICT: FAIL`. The router
wakes the planner with that report, and the planner decides: accept the work,
send follow-up instructions to the original implementor session via the
continue endpoint (the implementor keeps its session memory and worktree, and
validation repeats after it finishes again), or spawn a new implementor.

Validators are never resumed: each validation is a fresh session by
construction, so no validator state can pollute later runs. A second
validation of the same implementor gets a deduplicated validator name
(`validator-<name>`, `validator-<name>-2`, ...).

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
