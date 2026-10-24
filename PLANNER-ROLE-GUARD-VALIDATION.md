# Planner role guard and handoff validation record

## Interim validator note

An interim validator that uses the older live router may still read this file as its criteria source. This is a temporary transition only. Server code and tests do not read or depend on this markdown file. Use executable tests and the corrected handoff behavior as evidence. The current requested scope includes the approved report and criteria delivery correction. The provider/model pipeline UI extension is not approved.

## Worktree and branch

- Worktree: `/Users/bbagameri/github/cuck-code/router-prototype/lines/worktrees/7a3ffb86-4d6f-40c1-a624-ab5ce9aa9ad8/cuck-code/planner-role-guard`
- Branch: `7a3ffb86/planner-role-guard`
- Starting validated application commit: `23c9df9a6a1d58058e2aa2d67d567a179134aa11`
- Handoff implementation commit: `d89fb5dc109b70fd34655482268ccb1d3197ab68` (`Fix normalized planner and worker handoffs`).
- Deferred validation queue correction: `34940097d6f87813f1e77aba2ca372af3efb3904` (`Preserve deferred validation queue entries`).
- Queue correction code commit: `34940097d6f87813f1e77aba2ca372af3efb3904`.
- Do not use or change the shared checkout. Do not push `main` or `master`.

## Preserved planner-role acceptance criteria

1. Validate the assigned feature branch and exact worktree. Report the path and commit.
2. Put explicit planner-only rules before the user task on every invocation, including resumed sessions. Include line ID and current approval state.
3. Allow read-only inspection. Limit planner file changes to planning documents in the line workdir.
4. Prohibit planner application edits, implementation checks, and shared checkout changes.
5. Cover initial tasks, later user messages, feedback, approval events, implementor reports, and validation reports.
6. Require a plan and stop before approval. Cover authentication interruption before `plan.md` exists.
7. Do not treat unapproved `continue` as approval or a role change.
8. Require worker delegation after approval. Stop after authentication or API failures; do not implement directly.
9. Preserve event markers, report bodies, session behavior, verdicts, and criteria-only response instructions.
10. Preserve independent validation, original-worker corrections, integration approval, cleanup rules, and worker invocation behavior.
11. Test planner turn types, approval states, and duplicate-reminder prevention.
12. Run unit tests only. Do not run local integration or browser acceptance tests.
13. Keep unrelated shared-checkout changes and authentication detection unchanged.
14. Preserve exact user input, including quoted, repeated, incomplete, and leading context markers. Strip only an owned dispatch wrapper. Test approval refresh and one current wrapper.
15. Keep basic CI and static build validation. Report missing checks as unavailable, not pass. The approved CI addition does not approve the separate provider/model UI extension.

## Approved report and criteria handoff scope

1. Define one canonical text contract. Use normalized message `text` first. Support legacy string `content` and arrays of valid text blocks. Include assistant messages only. Exclude thinking, tool calls, tool results, malformed blocks, and other roles.
2. Preserve complete multiline text, Unicode, punctuation, numbered criteria, and verdicts. Do not truncate handoff payloads.
3. Capture normalized output for each planner or worker invocation separately from the capped UI transcript. Never use historical output when the current planner run has no criteria.
4. Forward the exact current criteria to the validator. Preserve explicit `SKIP VALIDATION`. Do not treat missing text as skip.
5. If criteria are empty, emit a clear diagnostic and do not start a validator. If a report or verdict is missing, emit a clear diagnostic and keep the verdict unset.
6. Preserve exact report and criteria association while deferred and saved. If a continuation supersedes the report's run before validation starts, explicitly cancel the stale item and require new criteria; never validate newer work with an older report.
7. Parse only a complete, explicit, final `VERDICT: PASS` or `VERDICT: FAIL` line. Ignore quoted examples, code fences, and incomplete output.
8. Set the worker status and verdict before state persistence, API results, completion events, or planner notifications. Keep those views consistent.
9. Follow Pi JSONL framing. Process split records, CRLF, and a buffered EOF record. Use completed `message_end` messages as authoritative; use `text_end` as the completed block value; avoid duplicate deltas. If no completed Pi message arrives, use the adapter's supported final block flush.
10. Keep Vibe, Pi, Codex, and Claude behavior covered by existing adapter fixtures. Do not require live providers.
11. Add unit contract tests from adapter output through criteria forwarding, complete report notifications, and final status/verdict state. Include empty criteria and dot-only report regressions, malformed events, multiple assistant messages, legacy content, Unicode, continuation, deferred validation, and transcript limits.
12. Run only unit tests and the authorized static build-validation command locally. Do not run live process/API end-to-end, integration, or browser acceptance tests.
13. Keep CI limited to unit tests and static build validation. Do not change authentication detection, add deployment, or change provider/model UI controls.
14. Document the root cause, text contract, invocation boundary, Pi framing, and diagnostics in `router-prototype/README.md`.

## Root cause and correction evidence

The old `reportText(transcript)` read `entry.content`, but normalized harness adapters emit `entry.text`. Therefore successful assistant messages became empty reports. `entryText()` did not handle legacy string content. Planner criteria were extracted from the capped, shared line transcript, so the router could use old output after an empty current turn. Pi stream parsing also discarded the final buffered JSONL record, and the Pi adapter could flush deltas after an empty authoritative `message_end`.

The correction uses `handoff.js` as the shared text, criteria, report, and verdict contract. `InvocationCapture` records normalized entries for one process run. The server keeps that capture separate from the 500-entry UI transcript. Deferred validation stores criteria and its matching implementor report. `JsonlDecoder` frames LF/CRLF records and returns a remaining EOF record. The Pi adapter clears deltas when a completed message arrives, including an empty one. It replaces partial text with authoritative `text_end` block content and flushes pending blocks only when no completed message arrives. Completion state and final verdict are set before saving and broadcasting. Reports use explicit complete-body boundaries and do not append punctuation to report text.

## Deferred validation queue correction

The validator found that the old `flushPendingValidations()` shifted the first item, then skipped it if the implementor was running. That dropped the saved criteria and report. `validation-queue.js` now owns the actual production flush operation. It inspects at most the queue length at the start of the pass. It rotates running implementors to the queue tail, so ready work can use free slots. It launches no more validators than the available capacity. Missing workers are discarded with an explicit reason. Removing an implementor removes its pending items deliberately.

Every pending item stores the implementor ID, exact criteria, matching report, and run generation. The server persists and restores those fields. A continuation advances the worker generation before saving state. A queued item remains while the worker runs. After the worker completes, a generation mismatch cancels the old item with an explicit `DEFERRED VALIDATION SUPERSEDED` notification. The old report and criteria are never used to check the newer worktree. The new run must receive new criteria. Repeated flushes cannot launch the same item twice because a successful launch removes it from the queue before the next pass.

## Commands and evidence

Run from the repository root:

- Unit tests: `node --test router-prototype/test/*.test.js` — **88 passed, 0 failed** after the queue correction.
- Static build validation: `node router-prototype/scripts/validate-build.js` — **11 checks passed** after adding `validation-queue.js` to the production source list.
- `git diff --check` — passed before commit `34940097d6f87813f1e77aba2ca372af3efb3904`.
- No local integration, browser, live process, or API tests were run.

This is a plain-JavaScript application. It has no transpilation or bundling build. Static validation parses production and browser JavaScript and inline scripts without executing them. It checks required and referenced local assets.

Required test evidence:

- Existing planner-role and report-marker tests still pass.
- Queue unit tests call the production `flushPendingValidationQueue()` module used by the server. They cover a running implementor with a free slot, mixed blocked and ready items, bounded scans, full capacity and later completion, repeat flushes, source-run supersession, deleted workers, and save/restore of exact criteria and report associations.
- Adapter/handoff tests cover normalized assistant messages, legacy string/block content, multiple assistant messages, malformed events, current-run isolation, transcript limits, full notifications, explicit and missing verdicts, and deferred/continued report association.
- Pi and JSONL tests cover fragmented input, Unicode, CRLF, final buffered input, authoritative completed content, and no duplicate deltas.
- Test outputs report exact totals and failures.
- Static validation succeeds. Do not run integration or browser tests.

## CI and remaining validation

Basic GitHub Actions push and pull-request checks are approved. Both checks passed for queue correction commit `34940097d6f87813f1e77aba2ca372af3efb3904`: [push run](https://github.com/bbaga/cuck-code/actions/runs/40136231589) and [pull-request run](https://github.com/bbaga/cuck-code/actions/runs/40136234207). Each ran unit tests and static JavaScript/local asset validation. A push alone is not a passing check.

The draft PR is <https://github.com/bbaga/cuck-code/pull/5>. Do not deploy, restart, or hot-patch the live router on port 7788. Do not start integration testing. Fresh integration and live process/API end-to-end checks belong to the separately authorized integration validator. This record is not an acceptance verdict. Independent validation must run against the pushed branch head, including the queue correction commit and this validation record.
