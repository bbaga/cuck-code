# Remaining `saveLine()` call sites

`saveLine()` returns `false` when the write fails. Patch P6 changes six commands to check this result. This list gives the other call sites in `router-prototype/server.js` that still ignore the result. Line numbers refer to `server.js` after patch P6.

Command used:

```sh
grep -n "saveLine(" router-prototype/server.js | grep -v "if (!saveLine\|function saveLine\|save: saveLine"
```

One match is not a call site: the `console.error` text inside `saveLine` (line 1100). Line 1179 passes `saveLine` as a callback and line 2030 passes it as `save: saveLine`; both are listed at the end.

Handling values: "undo and 500" (send an error and restore memory), "log only" (the state is rebuilt or is repeated by the next save), "needs design" (the team must decide).

| Line | Function or route | Effect after save | Proposed handling |
| ---- | ----------------- | ----------------- | ----------------- |
| 180 | `reconcileInventory` (discovers containers) | logs `inventory.discovered` | log only |
| 240 | `cleanupStage` | none | log only |
| 948 | `compactPlanner` (compact callback) | publishes context event, calls `pump` | needs design |
| 993 | `compactWorker` (compact callback) | publishes context event, calls `then` | needs design |
| 1267 | `pump` (planner run start) | starts the planner process | needs design |
| 1362 | `pump` (planner run end) | publishes error, retries wake, or continues | log only |
| 1374 | `pump` (wake retry) | logs `wake.retry` | log only |
| 1429 | `pump` (after planner run) | publishes state and status, calls `pump` | log only |
| 1462 | `flushPendingValidations` | logs deferred launch error | log only |
| 1494 | `trySpawnValidator` (changeset exceeded) | logs, enqueues planner wake message | log only |
| 1504 | `trySpawnValidator` (validation deferred) | logs, enqueues planner message | needs design |
| 1520 | `spawnWorker` | starts the worker process | needs design |
| 1638 | `workerClosed` | publishes `worker_status` event | log only |
| 1680 | `workerClosed` (changeset) | logs, enqueues wake message | log only |
| 1722 | `spawnValidator` (validator for an implementor) | publishes `worker_spawned`, starts process | undo and 500 (same pattern as P6 integration validator; the caller is internal, so it needs a return value path) |
| 2168 | `POST /api/lines/:id/inventory` kill-all | logs, sends 202 | undo and 500 |
| 2183 | `POST /api/lines/:id/inventory/:item` keep flag | logs, sends 202 | undo and 500 |
| 2190 | `POST /api/lines/:id/inventory/:item` kill | sends 202 (process already killed) | log only (the process is already stopped; cannot undo) |
| 2223 | `POST /api/protocol/lines/:id/repos` | logs `repo.registered`, sends 201 | undo and 500 |
| 2417 | `DELETE`/remove workers route (`worker.removed`) | publishes `worker_removed`, sends 200 | needs design (worktrees are already removed) |
| 2559 | evidence registration route | logs `evidence.registered`, sends 201 | undo and 500 |
| 2734 | worker continue route (`worker.continued`) | publishes `worker_status`, starts worker process | undo and 500 (before the spawn) |
| 2997 | `loadLines` (after reconcile of stale workers) | none | log only |
| 2999 | `loadLines` (legacy request ids) | none | log only |
| 3005 | `loadLines` (restored status) | calls `pump` when the queue has items | log only |

Callback uses (not changed by P6):

| Line | Function or route | Effect after save | Proposed handling |
| ---- | ----------------- | ----------------- | ----------------- |
| 1179 | `enqueueRequest` passes `saveLine` to `enqueuePlannerRequest` | calls `pump` when the enqueue is accepted | needs design (check that `enqueuePlannerRequest` reads the result) |
| 2030 | prompt route passes `save: saveLine` to `submitPrompt` | queues or starts the prompt | needs design (check that `submitPrompt` reads the result) |

Notes:

- The "Function or route" column names the nearest enclosing function or route found by reading the code. A few routes share a path prefix; read the code at the line number to be sure.
- Sites that save in the middle of a planner or worker run (1267 to 1680) cannot "undo and 500" because no request is waiting. They need a policy such as retry or mark the line as `attention`.
