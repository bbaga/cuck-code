# E3 local browser asset handoff

## Status and scope

This is a planning card for E3. No application code changed.

E3 remains blocked until an independent reviewer accepts this asset plan.

The inspected application root is `router-prototype/`.

The accepted E2 renderer is `web/markdown-renderer.js`.

The accepted E2 interface is `parseMarkdown(source)` and `renderMarkdown(document, source)`.

The E3 change must preserve plan Markdown, Mermaid diagrams, and assistant-only transcript Markdown.

The E3 change must not change user, router, error, or status text handling.

## Verified source map

1. `router-prototype/web/index.html:8` loads `https://cdn.jsdelivr.net/npm/marked@12/marked.min.js`.
2. `router-prototype/web/index.html:9` loads `https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js`.
3. `router-prototype/web/index.html:299` calls `mermaid.initialize({ startOnLoad: false, theme: "dark" })`.
4. `router-prototype/web/index.html:305-312` calls `marked.use` and overrides the code renderer.
5. The code renderer returns a `div.mermaid` for a `mermaid` fence.
6. The code renderer returns escaped HTML strings for other code fences.
7. `router-prototype/web/index.html:366-372` calls `marked.parse(content)` in `renderPlan`.
8. `renderPlan` finds every `div.mermaid` and calls `mermaid.run({ nodes: [node] })`.
9. Mermaid failure replaces the node with a text `pre`.
10. `router-prototype/web/index.html:1441-1442` clears and repopulates the plan body.
11. `router-prototype/web/index.html:914-975` creates and moves the plan body.
12. `router-prototype/web/index.html:124-126` styles Mermaid plan nodes.
13. `router-prototype/web/index.html:782` clears the transcript before replay.
14. `router-prototype/web/index.html:645-790` contains transcript follow and rendering logic.
15. `router-prototype/web/index.html:333-361` renders assistant entries with text nodes.
16. The current E2 branch therefore has no transcript consumer for marked.
17. The current E2 branch has no Mermaid consumer outside `renderPlan`.
18. `router-prototype/web/pipeline-ui.js` has no marked or Mermaid reference.
19. `router-prototype/web/registry-ui.js` has no marked or Mermaid reference.
20. `router-prototype/web/registry-ui-extra.js` has no marked or Mermaid reference.
21. `router-prototype/scripts/validate-build.js:12-22` lists required production scripts.
22. `validate-build.js:52-71` validates local script paths and skips remote URLs.
23. `router-prototype/test/validate-build.test.js` covers local assets and remote-script skipping.
24. `router-prototype/test/transcript-echo.test.js` extracts the current `renderPlan` boundary.
25. `router-prototype/test/markdown-renderer.test.js` tests the accepted local E2 renderer.
26. `router-prototype/test/fixtures/markdown-browser.js` serves the accepted native-browser Markdown fixture.

`router-prototype/index.html:8` contains a separate placeholder Tailwind script.
It is not loaded by the production server path described in `router-prototype/README.md`.
It is not a consumer of marked or Mermaid.
It needs a separate planner decision before any cleanup.

## Existing views and contracts

The plan view displays `plan.md` before and after approval.
It uses the same `planBody` node when the details panel moves.
It must keep headings, paragraphs, lists, block quotes, inline code, fenced code, and Mermaid fences.
It must keep Mermaid dark theme and fallback text on render failure.
It must preserve the current literal plan content input and approval controls.

The document view is the plan details view.
It is not an assistant transcript.
It must continue to render the same plan content after the asset migration.

The diagram view is the Mermaid block inside the plan body.
It must render more than one diagram after replacement or replay.
It must not render diagrams from assistant transcript text.

The assistant transcript must use the accepted local renderer only for assistant harness entries.
The renderer must create DOM nodes and fixed attributes.
It must keep code opaque and unsafe URLs inert.
User, router, error, status, system, reasoning, and unknown entries remain literal.

## Dependency decision

### Recommended bounded design

Use local pinned browser distributions for the existing plan view.
Keep `web/markdown-renderer.js` for assistant transcript Markdown.
Do not make the accepted renderer parse or render Mermaid.
Do not remove plan marked or Mermaid behavior.

Use these exact artifacts after approval:

- `marked@12.0.2`, npm registry URL `https://registry.npmjs.org/marked/-/marked-12.0.2.tgz`.
- `mermaid@10.9.1`, npm registry URL `https://registry.npmjs.org/mermaid/-/mermaid-10.9.1.tgz`.

Both package metadata records state the MIT license.
The registry metadata records `marked` unpacked size 924,459 bytes and 16 files.
The registry metadata records `mermaid` unpacked size 24,174,139 bytes and 364 files.
These values came from npm registry package metadata.
No downloaded package code was executed.

The browser entry points must be the pinned UMD-compatible files.
The proposed local paths are `web/vendor/marked-12.0.2.min.js` and `web/vendor/mermaid-10.9.1.min.js`.
The exact distribution file names and checksums require review after archive inspection.
The proposed paths must not be committed until that review passes.

Marked has no required browser runtime dependency in its package metadata.
Mermaid 10 has a bundled browser distribution for this current UMD usage.
The archive may contain source maps, declarations, tests, and source files.
The E3 card must copy only the browser runtime and required license notices.
No font is required by the current Mermaid CSS or code path.
No remote stylesheet, image, or runtime import is approved.

### Rejected alternatives

Do not replace Mermaid with plain text.
That would silently remove an existing plan and diagram feature.

Do not use a new CDN URL with a local fallback.
That still creates a remote runtime dependency.

Do not switch Mermaid to an unpinned major version.
That changes parser and browser compatibility without review.

Do not add a package manager or bundler for this card.
The application has no browser build step.

Do not use minification to conceal vendor scope.
Do not omit required license files.
Do not localize only marked while leaving Mermaid remote.

## Provenance and size estimate

The registry metadata gives 0.92 MB unpacked for marked and 24.17 MB unpacked for Mermaid.
The committed runtime size is unknown until the pinned archive is inspected.
The final review must record each selected file's byte count and SHA-256.

Expected first-party changes are about 30 lines in `web/index.html`.
Expected validator changes are about 10 lines only if local vendor paths need explicit policy.
Expected test changes are about 80 lines across focused asset and plan-render tests.
Expected license notices are about 20 lines.
Expected vendor files may exceed 500 changed lines even when minified.
Git line counts for minified files are not a safe size measure.

If the selected Mermaid runtime or required chunks cannot fit the worker limit, stop.
Request a separate vendor-localization card with its own change-set budget.
Do not declare E3 ready by dropping Mermaid or hiding vendor files.

## E3 prerequisite card

**Owner:** asset reviewer.

1. Inspect the two pinned archives without executing JavaScript.
2. Confirm the browser entry file, global names, license, and checksum.
3. Confirm whether Mermaid needs chunks, styles, fonts, or images.
4. Record selected files, byte counts, and total expected change size.
5. Confirm the result fits the approved change-set budget.
6. Stop and request a split when it does not fit.

**Done:** the reviewer records exact files and checksums.
The reviewer records no remote runtime request.
The reviewer records the final license files.

## E3 implementation recipe

1. Add the approved local runtime files under `router-prototype/web/vendor/`.
2. Add license notices beside those files.
3. Replace only the two remote script tags in `web/index.html`.
4. Keep script order before the inline dashboard script.
5. Keep the existing marked extension and `renderPlan` function contract.
6. Keep `mermaid.initialize` and per-node `mermaid.run` behavior.
7. Import the accepted local renderer for assistant entries.
8. Route only `role === "assistant"` harness messages to that renderer.
9. Keep all other transcript roles on text nodes or existing literal `pre` nodes.
10. Add scoped transcript Markdown and code overflow styles.
11. Preserve transcript follow, replay, and replacement behavior.
12. Update `validate-build.js` only when its existing local-asset rules need the vendor paths.
13. Add focused tests for local references and the unchanged plan contract.
14. Do not edit unrelated registry, pipeline, server, or prompt files.

Fixed interfaces are `renderPlan(state, content)`, `entryEl(entry)`, and the E2 renderer exports.
The plan path continues to accept Markdown strings.
The transcript path continues to receive normalized entry objects.

## Required tests and browser checks

Run only these unit tests after implementation:

1. `node --test router-prototype/test/validate-build.test.js`
2. `node --test router-prototype/test/markdown-renderer.test.js`
3. `node --test router-prototype/test/transcript-echo.test.js`
4. Any new focused asset test named by the implementation card.

Run static validation with `node router-prototype/scripts/validate-build.js`.
Do not run integration tests for this card.

Use the accepted native fixture from `test/fixtures/markdown-browser.js`.
Block external requests in the browser context before loading the fixture.
Check that local renderer assets resolve with status 200.
Check that no request targets a non-loopback host.
Check assistant Markdown for headings, lists, links, code, nesting, and line breaks.
Check malicious HTML and unsafe links remain inert.
Check repeated fixture replacement leaves one root tree.

After source branches combine, use the dashboard fixture P0-F1b2 if accepted.
P0-F1b2 remains unresolved and must not be skipped silently.
In the dashboard, load a real plan with Markdown and two Mermaid diagrams.
Check both diagrams render after replay and after plan replacement.
Check assistant-only Markdown renders through the accepted renderer.
Check malicious user text stays literal.
Check transcript follow remains at the bottom after new entries.
Check long assistant code stays inside the transcript.
Check D1 and D2 markers and geometry remain unchanged.

Use browser DOM checks for local script URLs, `div.mermaid`, rendered SVG, text nodes, and absence of source HTML nodes.
Use browser network checks with external requests blocked.
Record browser console errors and require zero errors.

## Planner decisions and blockers

1. The planner must approve the exact pinned archive files and checksums.
2. The asset reviewer owns the archive and license review.
3. The E3 implementor owns the local script replacement and routing changes.
4. The E3 validator owns independent native-browser checks.
5. The planner owns the change-set split if vendor files exceed 500 changed lines.
6. P0-F1b2 owns the unresolved dashboard fixture decision.

E3 is blocked by unreviewed vendor archive contents.
E3 is blocked if required Mermaid chunks exceed the change-set budget.
E3 is blocked until P0-F1b2 is accepted for dashboard browser evidence.
E3 is blocked if the local distribution needs remote imports.

The recommended design preserves every existing plan and diagram feature.
It uses the accepted local renderer for assistant output.
It adds no remote runtime dependency.

No implementation checks or tests ran for this design-only card.
