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

Then open http://localhost:7788. Configuration via env: `PORT` (default 7788)
and `LINES_DIR` (default `./lines`). Requires Node >= 18 and the `vibe` CLI on
PATH.

## Production lines

Creating a line makes a work directory under `lines/` and sends the initial
prompt to a headless Vibe run (`vibe --workdir ... --trust --agent accept-edits
--output streaming`). The first run yields a `sessionId`; every later prompt is
sent with `--resume <sessionId>`, so each line is one long-lived, stateful Vibe
conversation.

## Factory protocol

Each line is a graph: a planner (the line's Vibe session) plus the implementor
workers it spawns. On creation the planner writes `plan.md` (markdown, including
a mermaid diagram of the task graph) in its workdir and waits. A human reviews
the plan in the UI and either sends feedback (the planner revises `plan.md`) or
approves it. The router blocks worker spawning until approval.

On approval the planner spawns workers by calling the router's protocol API
(agents reach it with curl from bash):

- `POST /api/protocol/lines/:id/workers {name, prompt}` — spawn a worker.
  409 before plan approval, on a duplicate worker name, or past the cap of 8
  workers per line. Each worker runs in its own git worktree on branch
  `<lineIdPrefix>/<name>`, with no shared context with the planner: worker
  prompts must be self-contained.
- `GET /api/protocol/lines/:id/workers` — worker statuses (planner polling
  fallback).
- `POST /api/protocol/workers/:id/stop` — stop a worker; the planner is woken
  with a WORKER STOPPED prompt.

Independent tasks are spawned in parallel as parallel processes. Worker output
streams to the UI live, drawn as nodes connected to the planner node. When a
worker finishes (or fails, or is stopped), the router wakes the planner with
its report, and the planner decides what to do next: spawn follow-up workers,
restart a failed task under a new name, or conclude. The user can prompt the
planner at any time and stop any worker from the UI.

## Limitations

Single user, no authentication, and prompts on a line execute strictly one at
a time. Plan approval is a router-side gate only — the router blocks worker
spawning until a human approves, but does not check the plan's content. Lines
(id, name, session, planApproved, worker list) persist to
`lines/<id>/line.json` and are rehydrated on restart; transcripts are in
memory and do not survive a restart, and workers that were running when the
router stopped come back as "stopped".

## Security

Lines run with `--auto-approve`: a headless process has no one to answer
approval prompts, so every tool call (including `git push`, `gh`, file
deletion) runs without asking. Set `LINE_AUTO_APPROVE=0` to run lines under
`--agent accept-edits` instead — side-effecting commands will then be denied,
not queued.
