# UI/UX P0 execution handoff

Revision: P0 review, 2026-10-30

## 1. Confirmed checkout and hooks

1. The checkout root is `/Users/bbagameri/github/cuck-code/router-prototype/lines/worktrees/7aeb1fa2-da12-4ffd-8f3a-31e5949480dc/app/p0-execution-handoff`.
2. The application root is `router-prototype/` below that checkout.
3. The remote is `git@github.com:bbaga/cuck-code.git`.
4. The branch is `7aeb1fa2/p0-execution-handoff`.
5. Request construction is `planner-request.js:plannerRequest`.
6. Request restoration is `restorePlannerRequest` and `restorePlannerRequests`.
7. Request serialization is `serializePlannerRequest` and `serializePlannerRequests`.
8. Durable line persistence is `server.js:saveLine`.
9. Line restore is `server.js` near lines 2674-2750.
10. Queue insertion is `enqueuePlannerRequest`.
11. User submission is `submitPrompt`.
12. The prompt route is `server.js` near line 1882.
13. The current prompt response is `202 { queued: true, position }`.
14. The current initial state and SSE state use `dashboardStateForLine`.
15. State events use `broadcast`, `sseSend`, and `dashboardLive.publish`.
16. The dashboard SSE connection is `web/index.html` near line 1954.
17. The dashboard state handler is `addCard(...).handlers.state`.
18. Incremental transcript events use `entry` and `worker_entry` handlers.
19. The planner pump is `server.js:pump` near line 1160.
20. The pump guard checks deleted, running, compacting, and empty queue states.
21. Planner launch is inside `pump`.
22. Planner close and error handling are inside the launch close callback.
23. Planner child storage is `line.child`.
24. Compaction guards are `compactPlanner` and `compactWorker`.
25. Compaction uses `line.compacting`, `worker.compacting`, and summary children.
26. Transcript creation is `web/index.html:entryEl` near line 320.
27. Transcript rendering is `renderTranscript` and `appendEntry`.
28. Current transcript rendering uses DOM nodes, but it uses `innerHTML = ""` only to clear the container.
29. Current transcript role dispatch must be checked in `entryEl` before E1.
30. The existing attention helper is `web/pipeline-ui.js:attentionIndicator`.
31. The planner marker calls that helper near `web/index.html:590`.
32. The line-list marker calls that helper near `web/index.html:422`.
33. Existing overlay keyboard handling is `web/pipeline-ui.js` near line 575.
34. Existing prompt Enter handling is `web/pipeline-ui.js:promptKeyAction` and `index.html` near line 1195.
35. Existing evidence overlay state is `st.evidenceLightbox`.

## 2. Existing checks and fixture review

1. Run request checks from the application root with `node --test test/planner-request.test.js`.
2. Run pipeline checks with `node --test test/pipeline-ui.test.js`.
3. Run layout checks with `node --test test/layout-resize.test.js`.
4. Run transcript checks with `node --test test/transcript-scroll.test.js` and `node --test test/transcript-echo.test.js`.
5. Run compaction checks with `node --test test/compaction.test.js`.
6. Run server API checks with `node --test test/dashboard-events-api.test.js` and `node --test test/dashboard-live.test.js`.
7. Run build checks with `node --test test/validate-build.test.js` and `node scripts/validate-build.js`.
8. The full unit command is `node --test test/*.test.js`.
9. The repository has no package build step.
10. The repository has no fake planner child fixture.
11. The repository has no fake clock fixture.
12. The server API tests spawn the real Node server.
13. The existing tests do not provide the child and clock interfaces required by A3 and B2.

### Blocker P0-F1: deterministic lifecycle and DOM fixture

1. Owner: A3 implementor, with planner review before implementation.
2. Add `test/fixtures/planner-child.js`.
3. Export `createFakeChild({ close, error, signal })`.
4. The fake child must expose `stdout`, `stderr`, `on`, `kill`, and `emitClose`.
5. `kill(signal)` must record signals and return a boolean.
6. Add `test/fixtures/fake-clock.js`.
7. Export `createFakeClock(start)` with `now`, `setTimeout`, `clearTimeout`, and `advance(ms)`.
8. Add `test/fixtures/dom.js` only if existing DOM tests cannot load the page.
9. Export `createDocument()` and `loadDashboard(document, options)`.
10. The DOM fixture must create text nodes, event listeners, fetch, EventSource, and ResizeObserver.
11. It must not use a remote asset or a real planner.
12. Focused checks are `node --test test/fixtures/planner-child.test.js test/fixtures/fake-clock.test.js`.
13. Done means A3 can test close, duplicate close, signal escalation, and stale callbacks.
14. Done means B1-B3 can dispatch DOM events with deterministic responses.
15. This fixture card blocks A3, A4, B1, B2, and B3.

### Browser invocation

1. Use the Playwright MCP browser in headless mode.
2. Start the application only with a loopback fixture server.
3. Use viewport `1280x800`, then `768x800`.
4. Load `http://127.0.0.1:<port>/`.
5. Capture DOM snapshots and screenshots after each acceptance action.
6. Do not use the CDN scripts in `web/index.html` during browser checks.
7. The current page has remote `marked` and `mermaid` scripts.
8. This remote asset use conflicts with the approved local-assets rule.
9. E3 remains blocked until local asset validation passes.

## 3. Fixed protocol decisions

1. Add a durable opaque `id` to every request at construction.
2. Preserve the ID through restore, serialization, retry, and active state.
3. Normalize missing legacy IDs once during restore.
4. Persist normalized IDs before initial state or SSE publication.
5. Use `queuedUserPrompts: [{ id, text, position }]`.
6. Use `activePlannerRunId`, with `null` when idle.
7. Define a user request as `fromUser === true`.
8. Hide internal requests from the projection.
9. Keep internal queue order unchanged.
10. Add `requestId` to the successful prompt response.
11. Preserve `{ queued: true, position }` for compatibility.
12. `DELETE /api/lines/:lineId/prompts/:requestId` returns `200` with the projection.
13. Unknown line and unknown request return `404 { error }`.
14. Active and internal requests return `409 { error }`.
15. Eligibility and removal occur in one synchronous section.
16. Do not await between eligibility and removal.
17. Save and broadcast only after successful removal.
18. Do not add tombstones.
19. Assign a fresh run ID for each actual planner launch.
20. `POST /api/lines/:lineId/interrupt` requires exactly a valid string `runId`.
21. Malformed input returns `400`.
22. Unknown line returns `404`.
23. Idle, compacting, already stopping, and stale runs return `409`.
24. A matching active run returns `202` after stop request acceptance.
25. A `202` does not mean child exit.
26. Store run identity with the child and its timers.
27. Capture line identity and run identity for every browser response.
28. Ignore responses for an old line or old state revision.
29. Use a monotonic state revision for SSE and fetch reconciliation.
30. Increase the revision for every published authoritative state.
31. Ignore a lower revision after reconnect or line switch.
32. Refresh state after a conflict or reconnect.
33. Never optimistically remove queue rows.
34. Keep the draft until the matching submission succeeds.
35. Record the submitted text and draft generation.
36. Clear only when the response matches the submitted generation and unchanged text.
37. Preserve edits made during an in-flight request.
38. Never retry prompt submission automatically.

## 4. Child lifecycle and interruption

1. Reuse the current `pump` order and normal failure retry rules.
2. Mark intentional interruption before signalling the matching child.
3. Keep the request active until that child closes.
4. On close, clear only matching child, run, and timers.
5. Make close and error cleanup idempotent.
6. Suppress failure banners and retry only for intentional interruption.
7. Preserve transcript output already received.
8. Preserve ordinary failure and wake retry behavior.
9. Send `SIGTERM` first.
10. After two seconds, send `SIGKILL` to the same active child only.
11. After another two seconds, report a bounded termination error.
12. Clear every timer on close, error, and delete.
13. Never pump while the old child remains alive.
14. Pump once after matching close cleanup.
15. Ignore stale close and error callbacks.
16. Signal failure uses the existing `error` JSON field.
17. A failed signal reports an error and does not affect another run.
18. Compaction remains a hard pump guard.
19. Interrupt during compaction returns `409`.
20. Retries receive new run IDs.

## 5. Markdown security decision

1. No safe local Markdown parser exists in the application.
2. The page currently loads `marked` from a CDN.
3. The CDN parser is not acceptable for this plan.
4. E1 must add `web/markdown-renderer.js`.
5. Export `parseMarkdown(source)` and `renderMarkdown(document, source)`.
6. Export token constructors only if tests need them.
7. Use block tokens `paragraph`, `heading`, `list`, `quote`, and `code`.
8. Use inline tokens `text`, `code`, `em`, `strong`, `link`, and `break`.
9. Limit nesting to 8 levels.
10. Treat fenced code content as opaque text.
11. Treat unfinished fences as readable literal code.
12. Render with `createElement`, `createTextNode`, and `textContent`.
13. Never create source-derived HTML strings.
14. Allow only `http:`, `https:`, and `mailto:` links.
15. Reject `javascript:`, data URLs, control characters, and entity-obfuscated schemes.
16. Use fixed `href`, `target`, and `rel` attributes only.
17. Do not render images, raw HTML, iframes, extensions, or syntax highlighting.
18. Preserve unsupported syntax as literal text.
19. Test `<script>alert(1)</script>` as text.
20. Test `<img src=x onerror=alert(1)>` as text.
21. Test `<iframe src="javascript:alert(1)">` as text.
22. Test `[x](javascript:alert(1))` as text.
23. Test `[x](java&#x73;cript:alert(1))` as text.
24. Test links with newline and control characters.
25. Test literal `<`, `&`, backticks, and Markdown markers in code.
26. E3 routes Markdown only for assistant harness entries.
27. User, router, error, and status entries remain literal.
28. Remove the remote `marked` and `mermaid` scripts before E3 completion.

## 6. Card readiness and blockers

1. A1 is ready after the ID and legacy normalization decisions above.
2. A2 is ready after A1 and the synchronous cancellation rule.
3. A3 is blocked by P0-F1.
4. A4 is blocked by A3 and P0-F1.
5. D1 is ready for source and unit layout work.
6. D2 is ready and must reuse `attentionIndicator`.
7. E1 is blocked by the security review above until the parser interface is accepted.
8. E2 is blocked by E1 and P0-F1 DOM support.
9. E3 is blocked by E2 and the remote asset conflict.
10. B1 is blocked by A1, A2, A4, and P0-F1.
11. B2 is blocked by A3, A4, and P0-F1.
12. B3 is blocked by P0-F1 and the D1 layout evidence.
13. B1 must resolve stale response ordering before browser work starts.
14. A3 must resolve child ownership before A4 starts.
15. The planner must resolve the remote asset conflict before E3.
16. The planner must approve P0-F1 before lifecycle implementation.
17. No feature card may start from an unresolved alternative.

## 7. Executable card recipes

Run every command below from the application root: `router-prototype/`.
Commands marked **now** exist in this checkout. Commands marked **after P0-F1** need the approved fixture. Commands marked **after proposed test file** need the new test file named by that card. Do not run implementation checks during P0.

### A1 — Durable IDs and queue projection

- **Dependencies/readiness/blockers:** Ready. Use `plannerRequest`, `restorePlannerRequest(s)`, `serializePlannerRequest(s)`, `enqueuePlannerRequest`, `submitPrompt`, `dashboardStateForLine`, and `saveLine`. No unresolved blocker; A2 waits for A1.
- **Files:** `planner-request.js`; `test/planner-request.test.js`; `server.js` sections for `submitPrompt` and `dashboardStateForLine`; `test/dashboard-events-api.test.js` and `test/dashboard-live.test.js`.
- **Procedure:** (1) Add opaque IDs at construction and legacy normalization during restore. (2) Preserve IDs through serialization and persistence. (3) Add the pure waiting-user projection and use it in initial/SSE state. (4) Add `requestId` while preserving `queued` and `position`. (5) Test duplicate text, interleaved internal requests, and two restore/save cycles.
- **Commands:** **now** `node --test test/planner-request.test.js test/dashboard-events-api.test.js test/dashboard-live.test.js`. **After proposed test changes:** the same command.
- **Done:** IDs survive restore and retry; duplicate text has distinct IDs; internal rows stay hidden without reordering; projection has only `id`, `text`, `position`; old response fields remain.

### A2 — Cancel one waiting prompt

- **Dependencies/readiness/blockers:** Depends on accepted A1. Ready after A1; no new fixture. Cancellation must be synchronous and must not cancel active/internal work.
- **Files:** `planner-request.js` (`enqueuePlannerRequest` and request classification); `server.js` prompt route and `saveLine`/`broadcast`; `test/planner-request.test.js`; `test/dashboard-events-api.test.js`.
- **Procedure:** (1) Add classification for waiting-user, active/internal, and unknown IDs. (2) Remove one matching waiting request without `await`. (3) Add `DELETE /api/lines/:lineId/prompts/:requestId`. (4) Save and broadcast only after removal. (5) Test middle-row removal and dequeue race.
- **Commands:** **now** `node --test test/planner-request.test.js test/dashboard-events-api.test.js`. **After proposed test changes:** repeat that command.
- **Done:** success is `200` with sanitized state; unknown line/ID is `404`; active/internal is `409`; failed requests do not mutate; neighbors and internal order remain unchanged.

### A3 — Run identity and intentional stop

- **Dependencies/readiness/blockers:** Blocked by P0-F1 (`test/fixtures/planner-child.js`, `test/fixtures/fake-clock.js`). P0 must approve the existing lifecycle fallback before implementation. Depends on `pump` and its launch close/error callback.
- **Files:** `server.js` process lifecycle near `pump`, `line.child`, `compactPlanner`, and `compactWorker`; proposed `test/fixtures/planner-child.js`; proposed `test/fixtures/fake-clock.js`; proposed `test/server-interrupt.test.js`.
- **Procedure:** (1) Add a fresh run ID per launch and bind child/timers to it. (2) Mark intentional stop before `SIGTERM`; use same-child `SIGKILL` after 2 seconds and bounded error after another 2 seconds. (3) Make close/error cleanup idempotent and pump only after matching close. (4) Ignore stale callbacks and suppress only intentional failure/retry behavior. (5) Test duplicate close, retry IDs, signal failure, and ordinary failure.
- **Commands:** **now:** no implementation check. **After P0-F1 and proposed test file:** `node --test test/fixtures/planner-child.test.js test/fixtures/fake-clock.test.js test/server-interrupt.test.js`.
- **Done:** no early pump; exactly one post-close pump; output/order survive; stale callbacks cannot touch a newer run; timers clear; normal failure behavior remains.

### A4 — Interrupt endpoint

- **Dependencies/readiness/blockers:** Blocked by accepted A3 and P0-F1. Use A3's stop operation; do not duplicate lifecycle logic.
- **Files:** `server.js` interrupt route beside existing line routes; `test/dashboard-events-api.test.js`; proposed `test/server-interrupt-api.test.js`.
- **Procedure:** (1) Validate exact string `runId` and line existence. (2) Reject idle, compacting, stopping, and stale runs with the agreed `409` convention. (3) Call A3 and return `202` only after stop request acceptance. (4) Check initial state, endpoint response, and SSE use the same projection. (5) Test run X cannot signal run Y.
- **Commands:** **now** `node --test test/dashboard-events-api.test.js`. **After A3, P0-F1, and proposed test file:** `node --test test/server-interrupt-api.test.js test/dashboard-events-api.test.js`.
- **Done:** malformed input `400`, unknown line `404`, invalid state `409`, matching run `202`; save/broadcast and queue continuation occur only through A3.

### D1 — Pipeline containment

- **Dependencies/readiness/blockers:** Ready for source work. Browser evidence is required; use the existing `web/index.html` pipeline card. No remote asset approval is implied.
- **Files:** `web/index.html` pipeline CSS/DOM near pipeline rendering; `test/layout-resize.test.js`; proposed `test/pipeline-overflow.test.js` if the existing layout test cannot express scroll metrics.
- **Procedure:** (1) Inspect flex/grid ancestors. (2) Add only required `min-width: 0` and card-local overflow. (3) Make the panel body the horizontal scroll container. (4) Use a 2,000-character unbroken value. (5) Capture 1280x800 and 768x800 evidence.
- **Commands:** **now** `node --test test/layout-resize.test.js`. **After proposed test file:** `node --test test/pipeline-overflow.test.js test/layout-resize.test.js`.
- **Done:** dashboard/card width changes by at most 1 CSS pixel; no document overflow; panel scrolls; short values remain readable.

### D2 — Pipeline status marker

- **Dependencies/readiness/blockers:** Ready; depends on existing `attentionIndicator`. D1 overflow evidence remains required.
- **Files:** `web/index.html` pipeline title near line 590 and line-list marker near line 422; `web/pipeline-ui.js:attentionIndicator`; `test/pipeline-ui.test.js`; proposed `test/pipeline-status-dom.test.js` only if existing DOM coverage is insufficient.
- **Procedure:** (1) Call `attentionIndicator` with line-list state. (2) Put its marker before the pipeline name. (3) Reuse classes and accessibility label. (4) Cover idle, running, and failure states. (5) Recheck D1 long-value behavior.
- **Commands:** **now** `node --test test/pipeline-ui.test.js test/layout-resize.test.js`. **After proposed test file:** `node --test test/pipeline-status-dom.test.js test/pipeline-ui.test.js test/layout-resize.test.js`.
- **Done:** marker order, semantics, labels, and failure precedence match the line list; no second status algorithm exists.

### E1 — Markdown blocks and inert code

- **Dependencies/readiness/blockers:** Blocked until the experienced reviewer accepts the parser interface and security boundary in section 5. Remote `marked` remains rejected.
- **Files:** proposed `web/markdown-renderer.js`; proposed `test/markdown-renderer.test.js`.
- **Procedure:** (1) Export `parseMarkdown` and `renderMarkdown`. (2) Implement paragraph, heading, list, quote, and fenced-code tokens with nesting limit 8. (3) Keep code opaque; make unfinished fences readable. (4) Render with DOM APIs, never source-derived HTML. (5) Test raw HTML, Unicode, long code, and empty input.
- **Commands:** **now:** no implementation check. **After proposed test file:** `node --test test/markdown-renderer.test.js`.
- **Done:** block structure matches the approved interface; `<`, `&`, and Markdown markers in code stay literal; raw HTML is text; no remote parser is used.

### E2 — Inline formatting and safe DOM

- **Dependencies/readiness/blockers:** Blocked by accepted E1 and P0-F1 DOM support. Requires independent security review.
- **Files:** proposed `web/markdown-renderer.js`; proposed `test/markdown-renderer.test.js`; proposed `test/fixtures/dom.js` only if existing DOM loading is insufficient.
- **Procedure:** (1) Add inline code, emphasis, strong, links, and breaks without parsing inside code. (2) Allow only `http:`, `https:`, and `mailto:`. (3) Use text nodes and fixed safe attributes; reject controls and entity-obfuscated schemes. (4) Test script, image, iframe, unsafe links, malformed syntax, and repeated rendering.
- **Commands:** **now:** no implementation check. **After proposed test file:** `node --test test/markdown-renderer.test.js`. **After P0-F1 if DOM fixture is added:** `node --test test/fixtures/dom.test.js test/markdown-renderer.test.js`.
- **Done:** only approved elements/attributes exist; attack text is inert; code is opaque; security reviewer signs off.

### E3 — Assistant-only Markdown

- **Dependencies/readiness/blockers:** Blocked by accepted E2 and local-asset approval. The current remote `marked` and `mermaid` conflict stays explicit and unresolved until approval/evidence.
- **Files:** `web/index.html` (`entryEl`, `renderTranscript`, `appendEntry`); `web/markdown-renderer.js`; proposed `test/transcript-markdown.test.js`; `scripts/validate-build.js`; proposed `test/validate-build.test.js` only if the existing convention is absent.
- **Procedure:** (1) Route only assistant harness entries to the renderer. (2) Keep user/router/error/status entries literal pre-wrapped text. (3) Add scoped spacing, code scrolling, and links without changing follow behavior. (4) Remove remote assets only after approval and use local assets. (5) Test roles, rerendering, and long code.
- **Commands:** **now** `node scripts/validate-build.js`; **after proposed test file:** `node --test test/transcript-markdown.test.js`; **after local-asset approval:** `node --test test/validate-build.test.js` if added.
- **Done:** only assistant entries format; malicious user text stays literal; follow behavior and code containment pass; no remote requests remain.

### B1 — Queue UI and submission ownership

- **Dependencies/readiness/blockers:** Blocked by accepted A1, A2, A4, and P0-F1. Stale-response/reconnect revision rules in sections 3 and 6 are mandatory.
- **Files:** `web/index.html` composer/queue/state sections; `web/pipeline-ui.js` only for pure helpers; proposed `test/queue-ui.test.js`.
- **Procedure:** (1) Keep input enabled and record submitted text/generation. (2) Clear only a matching unchanged draft after `202`; never retry. (3) Render authoritative rows and disable only the selected Cancel. (4) Capture line/revision identity; ignore old responses and refresh after conflicts/reconnect. (5) Test edits during submission, cancel failure, line switch, and reconnect.
- **Commands:** **now** `node --test test/pipeline-ui.test.js test/dashboard-live.test.js`. **After P0-F1 and proposed test file:** `node --test test/queue-ui.test.js`.
- **Done:** two prompts preserve order; one cancellation leaves the other; failures preserve draft/row; late responses cannot corrupt another line.

### B2 — Double Escape interruption UI

- **Dependencies/readiness/blockers:** Blocked by accepted A3/A4 and P0-F1. Overlay, IME, blur, line identity, and stale-run rules are fixed; no retry on `409`.
- **Files:** proposed pure detector in `web/pipeline-ui.js`; `web/index.html` existing keyboard handler near `pipeline-ui.js` overlay handling; proposed `test/pipeline-ui-interrupt.test.js`.
- **Procedure:** (1) Add an injected-time detector: two unmodified, non-repeat Escapes within 600 ms. (2) Reset on other keys, modifiers, blur, line/composition changes, overlay consumption, trigger, or ineligibility. (3) Capture line/run identity and call once. (4) Show pending state until authoritative exit/error. (5) Test 599/600/601 ms, held keys, stale `409`, and IME.
- **Commands:** **now** `node --test test/pipeline-ui.test.js`. **After P0-F1 and proposed test file:** `node --test test/pipeline-ui-interrupt.test.js`.
- **Done:** one request targets the displayed run; holding Escape does not repeat; stale responses cannot interrupt a newer run; drafting and queue cancellation remain enabled.

### B3 — Fixed composer controls

- **Dependencies/readiness/blockers:** Blocked by P0-F1 and D1 layout evidence. Preserve existing `promptKeyAction`, Enter/Shift+Enter, and IME behavior.
- **Files:** `web/index.html` composer CSS/resize handling and `promptKeyAction`; proposed `test/composer-layout.test.js`.
- **Procedure:** (1) Set textarea maximum to `min(12rem, 35vh)` and enable vertical scrolling above it. (2) Keep Send/context controls fixed and aligned. (3) Do not change queue or interrupt logic. (4) Compare short and 30-line drafts at both approved viewports. (5) Recheck keyboard behavior.
- **Commands:** **now** `node --test test/layout-resize.test.js test/pipeline-ui.test.js`. **After P0-F1 and proposed test file:** `node --test test/composer-layout.test.js test/layout-resize.test.js`.
- **Done:** only textarea grows; controls differ by at most 1 CSS pixel; maximum and overflow are correct; keyboard and document geometry remain correct.

## 8. Review result

1. This correction changes only `router-prototype/docs/ui-ux-p0-handoff.md`.
2. No feature code or fixture implementation changed.
3. No implementation checks were run.
4. The remaining blockers are P0-F1, parser approval, lifecycle/security review, and the unresolved remote asset conflict.
5. The change set remains below 500 lines measured from the original base, including this document.
6. Fresh independent validation is required after this report.
