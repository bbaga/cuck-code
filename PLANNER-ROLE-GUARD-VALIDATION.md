# Planner role guard: implementor checklist and evidence

## Assigned worktree and revision

- Worktree: `/Users/bbagameri/github/cuck-code/router-prototype/lines/worktrees/7a3ffb86-4d6f-40c1-a624-ab5ce9aa9ad8/cuck-code/planner-role-guard`
- Branch: `7a3ffb86/planner-role-guard`
- Latest implementation and regression-test commit: `4a1de655b110b5e0fce6449ef9e0b012817fb807` (`Preserve planner report marker content`).
- Earlier planner prompt coverage commit: `dcc68f46a2d50c070735b05b5d44d62c1738c18c` (`Strengthen planner role guard coverage`).
- This record is committed after the implementation commit. The record commit is the final branch commit; see `git rev-parse HEAD` for its exact ID.
- The implementation files are `router-prototype/planner-turn.js` and `router-prototype/test/planner-turn.test.js`. This markdown record is also changed. No shared checkout was used or changed.

## Acceptance checklist and evidence

1. **Assigned branch and exact worktree.** Work was done only in the exact worktree and on branch above. This is implementor evidence only; the next independent validator must verify the same path, branch, and final commit.
2. **Planner rules before task.** `wrapPlannerTurn()` prepends planner-only rules before each payload. The prompt test checks that `ROLE: PLANNER` occurs before an initial task.
3. **Read-only inspection and planning-only file changes.** The wrapper allows read-only inspection and confines planning documents, including `plan.md`, to the line workdir. It prohibits edits to application files, tests, configuration, prompts, parent repositories, and shared checkouts.
4. **No application edits or implementation checks.** The wrapper explicitly prohibits application edits and implementation checks. An approved planner must use workers and the router API for implementation.
5. **Reminder on every invocation.** The server calls `wrapPlannerTurn()` in `pump()` for planner runs, including resumed runs. The wrapper names the line ID and current approval state every time. Tests verify that re-wrapping does not duplicate the outer context and refreshes the approval state.
6. **Turn and event coverage.** The wrapper covers initial and later user tasks, feedback, authentication interruption, approval, implementor reports, and validation reports. Tests cover representative prompts and preservation of the approval event and report bodies.
7. **Plan and stop; auth before plan exists.** Before approval, the wrapper directs the planner to write or revise `plan.md`, give a summary, and stop. If authentication interrupts before `plan.md` exists, it directs the planner to report the login action and stop. Prompt tests cover both.
8. **Continue is not approval.** The wrapper says that an unapproved continue message does not approve the plan or change the role. The resumed-continue test verifies this rule.
9. **Worker delegation and failures.** After approval, implementation must be delegated through router worker calls. If authentication or an API failure prevents delegation, the planner must report the blocker and stop; direct implementation is prohibited. The prompt test checks these rules.
10. **Protocol and report preservation.** The wrapper requires preservation of event markers, full report bodies, session behavior, verdicts, criteria-only instructions, and integration approval. Fix: the previous `indexOf(START)` / `indexOf(END)` logic could delete report content when it contained quoted wrapper markers. The dispatch now adds a random owner token to its context and unwraps only a complete context that starts with that exact dispatch-owned token. It leaves all other input unchanged. It does not remove newlines from the payload. Regression tests assert exact preservation of a report prefix, embedded quoted START/END markers, and verdict suffix; repeated marker pairs; incomplete markers; leading quoted markers; and normal owned-wrapper rewrapping with updated approval state and unchanged underlying content.
11. **Independent validation and existing behavior.** The wrapper preserves independent validation, corrections to the original implementor, integration approval, and existing cleanup and worker invocation behavior. It does not change report transport, event markers, server approval handling, cleanup, worker execution, or authentication detection.
12. **Prompt test coverage.** Tests cover initial and resumed turns; approved and unapproved states; feedback and approval events; authentication interruption; implementor and validation reports; and duplicate-reminder prevention.
13. **Unit tests only.** Commands and results:
    - `node --test router-prototype/test/planner-turn.test.js` — **10 passed, 0 failed** (planner prompt and marker-preservation tests).
    - `node --test router-prototype/test/*.test.js` — **62 passed, 0 failed** (full existing unit suite plus planner prompt tests).
    No integration or browser acceptance tests were run.
14. **Draft PR and CI.** Existing draft PR: <https://github.com/bbaga/cuck-code/pull/5>. After the implementation push, `gh pr view 5 --json url,state,isDraft,headRefName,baseRefName,statusCheckRollup,reviewDecision` reported OPEN, draft, head `7a3ffb86/planner-role-guard`, base `main`, empty review decision, and `statusCheckRollup: []`. No `.github/workflows` files exist in this repository. Therefore CI approval/checks are **UNAVAILABLE**, not PASS. The PR must be checked again after the record commit push.
15. **Unrelated changes and prohibited scope.** No shared-checkout changes or authentication-detection changes were made. No CI workflows or report-transport changes were added. Existing untracked `sessions/` files were not changed or committed.

## Remaining block and independent validation

The regression defect is fixed in commit `4a1de655b110b5e0fce6449ef9e0b012817fb807`. Unit tests pass: 10 planner prompt tests and 62 tests in the full suite. CI checks are UNAVAILABLE because this repository has no workflow files and the PR reports no check results. Do not treat missing checks as PASS. No integration tests ran locally. This is not an acceptance verdict. The next independent validator must validate the final branch commit and this exact worktree, explicitly run the embedded-marker content-preservation regression, review the PR's current checks, and issue its own verdict.
