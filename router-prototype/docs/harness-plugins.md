# Harness plugin guide (interface v1)

A harness plugin tells the router how to run one coding agent. The four
built-in harnesses (`vibe`, `pi`, `codex`, `claude`) and your own plugins
use the same interface. This guide describes the interface, the SDK, and two
working examples.

## Folder layout and layers

A plugin is a folder. The folder name is the plugin id.

```
<layer>/harnesses/<id>/index.js
```

`index.js` is a CommonJS file. It exports a factory function.

| Layer | Where | Notes |
|---|---|---|
| managed | `<LINES_DIR>/plugins/harnesses/<id>/` (default `./lines/plugins`) | Highest priority. |
| user | `$CUCK_HOME/harnesses/<id>/`, else `~/.cuck/harnesses/<id>/` | Your own plugins. |
| built-in | the router code | Reserved. A folder cannot add a built-in harness. |

- A plugin in the managed layer wins over a plugin with the same id in the user layer.
- The ids `vibe`, `pi`, `codex`, and `claude` are reserved. A folder with one
  of these names is skipped and listed in `pluginProblems`.
- The id must match `^[a-z][a-z0-9-]{0,63}$` and must equal the folder name.
- A plugin that does not load is skipped. The other plugins still work.

## The contract

```js
module.exports = function createHarnessPlugin(sdk) {
  return {
    apiVersion: 1,
    id: "remote-claude",               // equals the folder name
    displayName: "Remote Claude",      // optional, default = id
    capabilities: {
      resume: true,                    // resumeSession is usable
      systemPrompt: "file",            // "file" | "text" | "none"
      nativeTimeLimit: false,          // true: plugin enforces timeLimitSec itself
      providers: false,                // true: listProviders + checkAuth are implemented
    },
    // REQUIRED
    async probe(ctx) {},               // -> ProbeResult
    async listModels(ctx, query) {},   // query: { provider?: string } -> Choice[]
    startSession(ctx, request, sink) {},   // -> HarnessRun (sync; throw = could not start)
    resumeSession(ctx, request, sink) {},  // request.sessionId set -> HarnessRun
    // REQUIRED when capabilities.providers is true
    async listProviders(ctx) {},       // -> Choice[]
    async checkAuth(ctx, query) {},    // query: { provider } -> { auth, loginHint }
    // OPTIONAL
    async readTranscript(ctx, q) {},   // q: { sessionId, workdir } -> Entry[] | null
  };
};
```

The factory must return the plugin object at once. It must not return a Promise.
The plugin object may have only the keys above. Each `capabilities` key is required.

Required methods: `probe`, `listModels`, `startSession`, `resumeSession`.
Provider methods (required when `capabilities.providers` is `true`):
`listProviders`, `checkAuth`. Optional method: `readTranscript`.

### Types

- `Choice = { value: string, label: string }`
- `ProbeResult = { installed: boolean, version: string|null, auth: "ok"|"missing"|"unknown", loginHint: string }`
- `ctx = { sdk, env, pluginDir, log(level, event, data) }`.
  `env` is a copy of the router env. `pluginDir` is the plugin folder.
  `log` writes to the router log with the plugin id.
- `request = { phase, prompt, workdir, sessionId|null, model|null, effort, timeLimitSec, autoApprove, systemPrompt: string|null, systemPromptFile: string|null }`.
  `effort` is `"low"`, `"medium"`, or `"high"`.
- `Entry = { type: "message", role, text, sessionId, at }` (a router entry).
- `sink` (owned by the router, given to the run):
  - `sink.entry({ role, text })`: add a transcript entry. Only `role: "assistant"` can become a report.
  - `sink.session(id)`: set the session id. The first id wins.
  - `sink.contextTokens(n)`: set the context size. The latest value wins.
  - `sink.error(text)`: add a stream error. It never becomes a report.
- `HarnessRun = { stop(signal = "SIGTERM"): boolean, done: Promise<RunResult> }`
- `RunResult = { outcome: "ok"|"fail"|"timeout", exitCode: number|null, signal: string|null, command: string, spawnError: Error|null, stderr: string|null }`.
  `done` must not reject. If it rejects, the router uses `outcome: "fail"`.

### Router guarantees

- Every plugin call has a try/catch. A throw in `startSession` or
  `resumeSession` means the run could not start.
- Async discovery calls (`probe`, `listModels`, `listProviders`, `checkAuth`)
  have a 5-second time limit. A throw or a timeout in `probe` gives
  `{ installed: false, version: null, auth: "unknown", loginHint: "" }`
  and one logged problem (`harness_discovery_failed`).
- The router saves the first session id, the last context size, the entries, and the stream errors (up to 5, unique).

## SDK reference

The router passes `sdk` to the factory.

- `sdk.apiVersion`: `1`.
- `sdk.spawnJsonl(spec, parser, sink)`: returns a `HarnessRun`.
  - `spec = { cmd, args, env, cwd }`. The command starts without a shell.
    `env` is merged over `process.env`.
  - `parser = { record(obj, sink), end(sink), outcome(code, signal) }`.
    `record` runs for each JSON line of stdout. `end` runs when the process closes.
    `outcome` returns `"ok"`, `"fail"`, or `"timeout"`.
  - The SDK owns the child process, the JSONL decoding, the stderr capture,
    the spawn errors, and `stop`. If a parser throws, the result is
    `outcome: "fail"` and the error is in `spawnError`.
- `sdk.runCommand(argv, { timeoutMs = 2000 })`: returns
  `Promise<{ code, stdout } | null>`. The result is `null` when the command
  cannot start or when it exceeds the time limit.
- `sdk.builtin(id)`: returns the built-in plugin object for `id`.
- `sdk.extendBuiltin(baseId, options)`: returns a complete plugin. It reuses
  the argv, parser, resume, and transcripts of the built-in harness `baseId`.
  It runs `command` and `args` before the base argv.

Options of `extendBuiltin`:

| Option | Meaning |
|---|---|
| `id` | Plugin id (the folder name). |
| `displayName` | Name for the UI. Default: `id`. |
| `command` | The command to run. A value that starts with `./` is relative to the plugin folder. |
| `args` | Arguments that go before the base argv. Default: none. |
| `env` | Extra environment variables for the run. |
| `probe` | `{ versionArgs = ["--version"], authArgs, loginHint }`. The probe runs `command args versionArgs`. Without `authArgs`, there is no auth check. |
| `models` | List of strings or `{ value, label }`. Default: the models of the base harness. |

The result has `providers: false`. It has `readTranscript` when the base harness has it.

## Example 1: a pure JavaScript plugin

The `echo` plugin starts no process. The report is the first 200 characters
of the prompt. `nativeTimeLimit` is `true`, so the router sets no kill timer.
The run settles on the next tick, so the router sees a started run first.

`echo/index.js`:

```js
"use strict";

// A pure JavaScript harness plugin. It starts no child process: the report
// is the first 200 characters of the prompt.

const crypto = require("node:crypto");

module.exports = function createHarnessPlugin() {
  // The run settles on the next tick, so the router sees a started run first.
  function run(sessionId, request, sink) {
    sink.session(sessionId);
    sink.entry({ role: "assistant", text: String(request.prompt).slice(0, 200) });
    const result = { outcome: "ok", exitCode: 0, signal: null, command: "echo", spawnError: null, stderr: null };
    return { stop: () => false, done: new Promise((resolve) => setImmediate(() => resolve(result))) };
  }

  return {
    apiVersion: 1,
    id: "echo",
    displayName: "Echo",
    capabilities: { resume: true, systemPrompt: "none", nativeTimeLimit: true, providers: false },
    async probe() { return { installed: true, version: "echo 1", auth: "ok", loginHint: "" }; },
    async listModels() { return [{ value: "echo", label: "Echo" }]; },
    startSession: (ctx, request, sink) => run(`echo-${crypto.randomBytes(4).toString("hex")}`, request, sink),
    resumeSession: (ctx, request, sink) => run(request.sessionId, request, sink),
  };
};
```

## Example 2: run a built-in CLI on another machine

The `remote-claude` plugin reuses the `claude` harness. Only the command
changes. The command is a script in the plugin folder.

`remote-claude/index.js`:

```js
"use strict";

// Runs the Claude Code CLI on another machine. The built-in claude argv,
// parser, resume and transcripts are reused. Only the command changes.
module.exports = (sdk) => sdk.extendBuiltin("claude", {
  id: "remote-claude",
  displayName: "Remote Claude",
  command: "./bin/remote-claude",
});
```

`remote-claude/bin/remote-claude`:

```sh
#!/bin/sh
exec ssh "${REMOTE_HOST:?set REMOTE_HOST}" claude "$@"
```

The script must be executable (`chmod +x bin/remote-claude`). Set
`REMOTE_HOST` in the router environment.

## Resume

When `request.sessionId` is set, the router calls `resumeSession`. Otherwise
it calls `startSession`. Set `capabilities.resume` to `true` only if
`resumeSession` can continue the session. The plugin reports the session id
with `sink.session(id)` during the first run. The router keeps the first id and
sends it back as `request.sessionId` in later runs.

## Time limit

`request.timeLimitSec` is the limit for one run. By default, the router sets a
timer. When the timer ends, the router calls `run.stop("SIGTERM")`. Your
`done` promise must then settle. If `capabilities.nativeTimeLimit` is `true`,
the router sets no timer. The plugin must stop itself and return
`outcome: "timeout"`.

## System prompt modes

The role prompt of a worker is a trusted text. `capabilities.systemPrompt`
tells the router how to give it to the plugin.

| Mode | What the router does |
|---|---|
| `"none"` | The plugin has no system prompt channel. The router sets `systemPrompt` and `systemPromptFile` to `null`. The role prompt stays in the user prompt. |
| `"text"` | The router always sets `request.systemPrompt` (inline text). |
| `"file"` | A prompt of 1000 characters or more comes as `request.systemPromptFile`: a file that the router owns. A shorter prompt comes as `request.systemPrompt`. |

When the router uses a channel, the user prompt holds only the task. The plugin
must never put the role prompt into the user prompt.

## Check a plugin

1. Put the folder in the managed or user layer.
2. Restart the router (see "Reload rules").
3. Call `GET /api/harnesses`.
4. Find your plugin in `harnesses`. It has `displayName`, `capabilities`, and
   `plugin: { layer, folder }`. Built-in harnesses have no `plugin` key.
5. Read `pluginProblems`. It is `[{ layer, path, errors }]`. An empty list
   means that all plugins loaded. Each router log line for a problem has the
   event `catalog.problem`.
6. If the harness has `capabilities.providers`, call
   `GET /api/harnesses/<id>?provider=<provider>`. An unknown id gives 404.
   A harness without providers gives 400.

## Reload rules

- The router reads the plugin folders at boot. It reads them again after each
  write through the pipelines API (a managed pipeline write).
- After you edit a plugin by hand, restart the router.
- `GET /api/harnesses?refresh=1` skips the 30-second probe cache. It runs the
  `probe` of each plugin again. It does not read the plugin folders again.

## Security

Harness plugins run inside the router process with its user rights. A plugin
can read files, start processes, and use the network. Install only trusted code.
