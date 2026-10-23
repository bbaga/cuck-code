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

## Limitations

Single user, no authentication, all state in memory (a restart loses lines and
transcripts), and prompts on a line execute strictly one at a time.
