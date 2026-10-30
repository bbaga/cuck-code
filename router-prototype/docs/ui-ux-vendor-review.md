# E3 Vendor Archive Review

## Decision

This review does not approve vendor integration.

The selected Mermaid file exceeds the worker line limit.

The planner must create a separate vendor card.

The card must receive a larger change-set budget.

The application card must not hide vendor lines.

No archive or vendor code entered this repository.

## Scope and provenance

1. The review used the marked 12.0.2 archive.
2. The review used the mermaid 10.9.1 archive.
3. The marked archive URL is `https://registry.npmjs.org/marked/-/marked-12.0.2.tgz`.
4. The Mermaid archive URL is `https://registry.npmjs.org/mermaid/-/mermaid-10.9.1.tgz`.
5. Version metadata came from the npm registry version endpoints.
6. The marked metadata URL is `https://registry.npmjs.org/marked/12.0.2`.
7. The Mermaid metadata URL is `https://registry.npmjs.org/mermaid/10.9.1`.
8. The review downloaded archives into a temporary directory.
9. The review removed the temporary directory after inspection.
10. No downloaded code was executed.
11. No downloaded module was imported.
12. No package install or build script ran.
13. No browser loaded downloaded code.
14. No implementation or integration test ran.

## Safe inspection procedure

The following procedure inspects names and bytes without extraction.

1. Create a temporary directory with `mktemp -d`.
2. Download both archives with `curl -fsSL`.
3. Download both version metadata documents with `curl -fsSL`.
4. Open each archive with Python `tarfile` in read mode.
5. Reject absolute member names.
6. Reject member names containing `..` path components.
7. Reject symbolic links and hard links.
8. Record member names, sizes, hashes, and line counts.
9. Search text only with byte decoding and regular expressions.
10. Remove all temporary files with a shell trap.

The inspection found no unsafe archive members.

## Archive integrity

| Package | Registry integrity | Archive SHA-256 | Registry shasum | Result |
| --- | --- | --- | --- | --- |
| marked 12.0.2 | `sha512-qXUm7e/YKFoqFPYPa3Ukg9xlI5cyAtGmyEIzMfW//m6kXwCy2Ps9DYf5ioijFKQ8qyuscrHoY04iJGctu2Kg0Q==` | `6cfd2d09c6bce2541558a1547e5f3b9895ed743f0d287536ff2280e318e8a074` | `b31578fe608b599944c69807b00f18edab84647e` | Match |
| mermaid 10.9.1 | `sha512-Mx45Obds5W1UkW1nv/7dHRsbfMM1aOKA2+Pxs/IGHNonygDHwmng8xTHyS9z4KWVi0rbko8gjiBmuwwXQ7tiNA==` | `370ad9d7815e5fb54a059efce9be436740b74849b6fcdff21d1565379c6cd073` | `5f582c23f3186c46c6aa673e59eeb46d741b2ea6` | Match |

The registry integrity values were verified against the downloaded bytes.

The recorded archive hashes support later independent review.

## Selected artifact manifest

These files are proposed artifacts only.

They must not enter the application card.

| Package file | Proposed destination | Bytes | Lines | SHA-256 |
| --- | --- | ---: | ---: | --- |
| `package/marked.min.js` | `router-prototype/web/vendor/marked-12.0.2.min.js` | 35,479 | 7 | `15fabce5b65898b32b03f5ed25e9f891a729ad4c0d6d877110a7744aa847a894` |
| `package/LICENSE.md` | `router-prototype/web/vendor/MARKED-LICENSE.md` | 2,942 | 45 | `8e3a3f82f59a60958f56ca08f445647c32a4733dc7ca6c2c46f6eb898471ab9c` |
| `package/dist/mermaid.min.js` | `router-prototype/web/vendor/mermaid-10.9.1.min.js` | 3,335,717 | 2,030 | `61b335a46df05a7ce1c98378f60e5f3e77a7fb608a1056997e8a649304a936d6` |
| `package/LICENSE` | `router-prototype/web/vendor/MERMAID-LICENSE` | 1,089 | 22 | `ec9fb67dcb25eccc416ed56e1aab819222c805a2a4bfe4cb19e7556bf2ffde80` |

The selected files total 3,375,227 bytes.

The selected files total 2,104 lines.

The runtime files total 3,371,196 bytes.

The runtime files total 2,037 lines.

The metadata reports 16 marked files and 364 Mermaid files.

The metadata reports 924,459 marked unpacked bytes.

The metadata reports 24,174,139 Mermaid unpacked bytes.

## Runtime and compatibility findings

1. Marked exposes `package/marked.min.js` as an explicit package export.
2. Marked metadata names `lib/marked.umd.js` as its browser build.
3. The minified file is the bounded browser artifact.
4. The current page expects the global `marked` interface.
5. The current page calls `marked.use` and `marked.parse`.
6. The artifact contains no external import statement.
7. No marked runtime chunk is required.

8. Mermaid exposes `package/dist/mermaid.min.js` in the distribution.
9. Mermaid metadata exposes the module entry separately.
10. The minified distribution is a bundled browser artifact.
11. The artifact contains the `mermaid` global interface.
12. The current page calls `mermaid.initialize` and `mermaid.run`.
13. The artifact has no dynamic import expression.
14. The artifact has no stylesheet import.
15. The artifact has no font import.
16. The artifact has no image import.
17. The artifact contains embedded URL text for diagram and license formats.
18. Embedded URL text does not prove a network request.
19. Static review cannot prove runtime network behavior.
20. A browser network test must block external requests.
21. The test must record every attempted non-loopback request.

The archive contains many other Mermaid chunks.

The minified browser file appears self-contained.

The review does not approve those other chunks.

The review cannot prove every runtime diagram path without browser evidence.

Mermaid may include diagram features that need further native-browser checks.

The current plan uses two Mermaid diagrams.

The future validator must test both diagrams after replay and replacement.

## License findings

1. Both package metadata documents state the MIT license.
2. Marked supplies `package/LICENSE.md`.
3. Mermaid supplies `package/LICENSE`.
4. The proposed destinations preserve both license texts.
5. The archives supply no separate dependency notice files.
6. The minified files include bundled license comments.
7. A legal owner must confirm whether bundled dependency notices are required.
8. The implementation card must not remove license comments.
9. The implementation card must retain both package license files.

This review records the package license facts.

It does not provide legal approval for bundled dependencies.

## Size and change-set result

The worker limit is 500 changed lines.

The selected artifacts require 2,104 lines before first-party changes.

The runtime files alone require 2,037 lines.

The expected first-party changes add about 30 lines.

Focused tests and notices add about 90 lines.

The combined change exceeds the worker limit.

A minified file still counts as changed lines.

The planner must not count only byte size.

The planner must not hide vendor files in another commit.

The planner must create a bounded vendor-localization card.

The planner must also create a separate application card if needed.

## Next card

### Files

1. Add `router-prototype/web/vendor/marked-12.0.2.min.js`.
2. Add `router-prototype/web/vendor/mermaid-10.9.1.min.js`.
3. Add `router-prototype/web/vendor/MARKED-LICENSE.md`.
4. Add `router-prototype/web/vendor/MERMAID-LICENSE`.
5. Change only the two script URLs in `router-prototype/web/index.html`.
6. Add focused local-asset validation only when required.

### Steps

1. Copy only the four approved artifacts.
2. Verify every copied hash against this manifest.
3. Keep script order before the dashboard script.
4. Preserve `marked.use` and `marked.parse`.
5. Preserve `mermaid.initialize` and `mermaid.run`.
6. Preserve Mermaid fallback text.
7. Preserve assistant-only local DOM rendering.
8. Block external browser requests during validation.
9. Check both diagrams after replay.
10. Check both diagrams after plan replacement.
11. Check malicious user text as literal text.
12. Check assistant Markdown through the accepted renderer.
13. Check browser console errors.

### Tests and done criteria

1. Run the three focused unit tests from the asset handoff.
2. Run any new focused asset unit test.
3. Run static build validation.
4. Run the accepted native-browser fixture.
5. Require zero console errors.
6. Require zero non-loopback requests.
7. Require both Mermaid diagrams to render.
8. Require transcript role isolation to remain unchanged.
9. Record final hashes and the final changed-line count.
10. Stop if the closure or budget changes.

## Remaining gates

1. The planner must approve the separate vendor budget.
2. The planner must approve the exact artifact hashes.
3. A legal owner must confirm dependency notice handling.
4. The validator must confirm browser network behavior.
5. P0-F1b2 dashboard fixture approval remains unresolved.
6. E3 remains blocked until these gates pass.

This review does not approve E3.

It does not approve E3 browser behavior.

It does not approve E3, final integration, or remote dependency removal.
