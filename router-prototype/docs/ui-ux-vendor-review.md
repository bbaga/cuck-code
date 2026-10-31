# E3 Vendor Archive Review

## Decision

This review does not approve vendor integration.

The selected Mermaid file has 2,029 lines. It exceeds the 500-line worker limit.

The selected marked file has 6 lines. It fits the 500-line limit.

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

Every claim in this document uses one of these commands or URLs.

`T` is a new empty directory. Each archive has its own subdirectory.

1. `T=$(mktemp -d)`; `mkdir $T/m $T/x $T/meta`
2. `curl -fsSL -o $T/m/marked.tgz https://registry.npmjs.org/marked/-/marked-12.0.2.tgz`
3. `curl -fsSL -o $T/x/mermaid.tgz https://registry.npmjs.org/mermaid/-/mermaid-10.9.1.tgz`
4. `curl -fsSL -o $T/meta/marked.json https://registry.npmjs.org/marked/12.0.2`
5. `curl -fsSL -o $T/meta/mermaid.json https://registry.npmjs.org/mermaid/10.9.1`
6. `tar -tzf <archive>` lists members. Check for absolute names, `..`, and links.
7. `tar -xzf $T/m/marked.tgz -C $T/m` and `tar -xzf $T/x/mermaid.tgz -C $T/x`
8. Files are read as text only. No file runs. No `npm install` runs.
9. `rm -rf $T` removes all temporary files.

The review found no unsafe archive members.

## Archive integrity

Command: `shasum -a 256 $T/m/marked.tgz $T/x/mermaid.tgz`

| Package | Registry integrity (`dist.integrity`) | Archive SHA-256 | Registry shasum (`dist.shasum`) | Result |
| --- | --- | --- | --- | --- |
| marked 12.0.2 | `sha512-qXUm7e/YKFoqFPYPa3Ukg9xlI5cyAtGmyEIzMfW//m6kXwCy2Ps9DYf5ioijFKQ8qyuscrHoY04iJGctu2Kg0Q==` | `6cfd2d09c6bce2541558a1547e5f3b9895ed743f0d287536ff2280e318e8a074` | `b31578fe608b599944c69807b00f18edab84647e` | Match |
| mermaid 10.9.1 | `sha512-Mx45Obds5W1UkW1nv/7dHRsbfMM1aOKA2+Pxs/IGHNonygDHwmng8xTHyS9z4KWVi0rbko8gjiBmuwwXQ7tiNA==` | `370ad9d7815e5fb54a059efce9be436740b74849b6fcdff21d1565379c6cd073` | `5f582c23f3186c46c6aa673e59eeb46d741b2ea6` | Match |

The SHA-256 values were recomputed in this revision. They equal the earlier values.

## Selected artifact manifest

These files are proposed artifacts only. They must not enter the application card.

Line convention: the line count is the number of newline characters, as `wc -l` reports it.

Commands: `wc -l < FILE`, `wc -c < FILE`, `shasum -a 256 FILE` on each extracted file.

| Package file | Proposed destination | Bytes | Lines (`wc -l`) | 500-line limit | SHA-256 |
| --- | --- | ---: | ---: | --- | --- |
| `package/marked.min.js` | `router-prototype/web/vendor/marked-12.0.2.min.js` | 35,479 | 6 | Fits | `15fabce5b65898b32b03f5ed25e9f891a729ad4c0d6d877110a7744aa847a894` |
| `package/LICENSE.md` | `router-prototype/web/vendor/MARKED-LICENSE.md` | 2,942 | 44 | Fits | `8e3a3f82f59a60958f56ca08f445647c32a4733dc7ca6c2c46f6eb898471ab9c` |
| `package/dist/mermaid.min.js` | `router-prototype/web/vendor/mermaid-10.9.1.min.js` | 3,335,717 | 2,029 | Exceeds | `61b335a46df05a7ce1c98378f60e5f3e77a7fb608a1056997e8a649304a936d6` |
| `package/LICENSE` | `router-prototype/web/vendor/MERMAID-LICENSE` | 1,089 | 21 | Fits | `ec9fb67dcb25eccc416ed56e1aab819222c805a2a4bfe4cb19e7556bf2ffde80` |

The marked file `marked.min.js` has 6 lines. It fits the 500-line limit alone.

The Mermaid file `mermaid.min.js` has 2,029 lines. It exceeds the limit alone.

The four files total 3,375,227 bytes and 2,100 lines.

The two runtime files total 3,371,196 bytes and 2,035 lines.

Registry file counts: read `dist.fileCount` and `dist.unpackedSize` in each metadata document.

## Runtime and compatibility findings

1. Marked exports `./marked.min.js`. Check: metadata field `exports`.
2. Marked metadata has no `browser` field. Field `main` is `./lib/marked.cjs`. Field `module` is `./lib/marked.esm.js`.
3. `marked.min.js` starts with a UMD wrapper. It sets a global when no module system exists. Command: `head -c 300 marked.min.js`.
4. Mermaid metadata has `module` = `./dist/mermaid.core.mjs`. It has no `browser` field.
5. `dist/mermaid.min.js` is the browser file. The current page expects globals `marked` and `mermaid`.
6. Static review cannot prove runtime network behavior. A browser network test must block external requests and record each non-loopback request.

## Dependency closure

### marked 12.0.2

Metadata field `dependencies` is absent in `https://registry.npmjs.org/marked/12.0.2`. Marked has no runtime dependencies.

Browser load order: 1. `marked.min.js`. No other file.

Searches on `marked.min.js` (`grep -oE PATTERN FILE | wc -l`):

| Pattern | Matches |
| --- | ---: |
| `import\s*\(` | 0 |
| `require\(` | 0 |
| `https?://[^"' )]*\.js` | 0 |
| `<script` | 0 |

### mermaid 10.9.1

Source: field `dependencies` in `https://registry.npmjs.org/mermaid/10.9.1`. It lists 20 runtime dependencies (count: `len(dependencies)` in the JSON; 9 Included, 9 NOT VERIFIED, 2 type-only).

Searches on `dist/mermaid.min.js` (`grep -oE PATTERN FILE | wc -l`):

| Pattern | Matches | Meaning |
| --- | ---: | --- |
| `import\s*\(` | 0 | no dynamic import |
| `\bimport\s+[^(]` | 2 | both are text in cytoscape error messages ("Did you forget to import it") |
| `require\(` | 1 | Node `util` probe in a lodash helper, guarded by `YF&&YF.require` |
| `https?://[^"' )]*\.js` | 1 | jQuery GitHub URL in a comment |
| `<script` | 0 | no script tag |
| `importScripts` | 0 | none |
| `sourceMappingURL` | 0 | none |

The bundle has an inner module map for elkjs. It lists `./elk-api.js`, `./elk-worker.min.js`, and `web-worker`. The `web-worker` module is `d.exports=Worker`. The file `elk-worker.min.js` is not a separate archive file for this bundle. The map keeps these modules inside the bundle.

Inclusion per dependency. "Included" means the name or a distinct code marker is in the bundle. Counts use `grep -oF STRING dist/mermaid.min.js | wc -l`.

| Dependency | Range | Result | Evidence (STRING: count) |
| --- | --- | --- | --- |
| @braintree/sanitize-url | ^6.0.1 | Included | `sanitizeUrl`: 10, `about:blank`: 1 |
| @types/d3-scale | ^4.0.3 | Not applicable | Type-only package. No runtime code. |
| @types/d3-scale-chromatic | ^3.0.0 | Not applicable | Type-only package. No runtime code. |
| cytoscape | ^3.28.1 | Included | `cytoscape`: 6, `__________cytoscape_stylesheet` present |
| cytoscape-cose-bilkent | ^4.1.0 | Included | `cose-bilkent`: 2, `layoutBase`: 5 |
| d3 | ^7.4.0 | NOT VERIFIED | Minified names. `d3`: 35 matches are not unique to d3. |
| d3-sankey | ^0.12.3 | NOT VERIFIED | `sankey`: 9 matches. No unique marker found. |
| dagre-d3-es | 7.0.10 | NOT VERIFIED | `dagre`: 10, `dagre-d3`: 1. Not tied to the package. |
| dayjs | ^1.11.7 | NOT VERIFIED | `dayjs`: 0. Names are minified. |
| dompurify | ^3.0.5 | Included | Banner `@license DOMPurify 3.0.9`: 1 |
| elkjs | ^0.9.0 | Included | `./elk-api.js`: 2, inner module map present |
| katex | ^0.16.9 | Included | `katex`: 11, `KaTeX`: 6 |
| khroma | ^2.0.0 | NOT VERIFIED | `khroma`: 0. Names are minified. |
| lodash-es | ^4.17.21 | Included | `__lodash_hash_undefined__`: 5 |
| mdast-util-from-markdown | ^1.3.0 | Included | `mdastExtensions`: 1 |
| non-layered-tidy-tree-layout | ^2.0.2 | NOT VERIFIED | `tidy`: 0. Names are minified. |
| stylis | ^4.1.3 | NOT VERIFIED | `stylis`: 0. Names are minified. |
| ts-dedent | ^2.2.0 | NOT VERIFIED | `dedent`: 0. Names are minified. |
| uuid | ^9.0.0 | NOT VERIFIED | `uuid`: 0. Names are minified. |
| web-worker | ^1.2.0 | Included | module map entry `d.exports=Worker`, `web-worker`: 4 |

Conclusion on self-containment: the searches found no external load of any dependency. The searches found no import call, no script tag, and no script URL.

The bundle is self-contained for loading: NOT VERIFIED as complete. Reason: 9 dependencies have no unique marker in minified text. A browser test with blocked requests must confirm it.

The Mermaid archive contains 364 files (`tar -tzf mermaid.tgz | wc -l`). This equals `dist.fileCount` 364 in the metadata. Of these, 360 are under `dist/` (`tar -tzf mermaid.tgz | grep -c '^package/dist/'`). The bundle does not load them: `grep -oF 'import(' dist/mermaid.min.js | wc -l` returns 0. The review does not approve them.

The marked archive contains 16 files (`tar -tzf marked.tgz | wc -l`). This equals `dist.fileCount` 16 in the metadata. None is under `dist/` (`tar -tzf marked.tgz | grep -c '^package/dist/'` returns 0).

Files a browser loads, in order:

1. marked: `marked.min.js`.
2. mermaid: `dist/mermaid.min.js`.
3. No other file. This rests on the zero-match searches above plus the NOT VERIFIED condition for Mermaid.

## License findings

Commands: read field `license` in each metadata document; `tar -tzf ARCHIVE | grep -iE 'notice|license|third|copying'`.

1. Marked metadata: `MIT`. License file checked: `package/LICENSE.md`.
2. Mermaid metadata: `MIT`. License file checked: `package/LICENSE`.
3. The grep on the marked archive lists only `package/LICENSE.md`.
4. The grep on the Mermaid archive lists only `package/LICENSE`.
5. The archives contain no separate dependency notice files. Check: the grep in items 3 and 4.

### Dependency licenses

Choice: for each range, the newest stable version that the range allows. Source: `https://registry.npmjs.org/NAME` (field `versions[VERSION].license`) on 2026-10-31. The bundle can contain an older version than this table. The table is not proof of the bundled version.

| Name | Version | License |
| --- | --- | --- |
| @braintree/sanitize-url | 6.0.4 | MIT |
| @types/d3-scale | 4.0.9 | MIT |
| @types/d3-scale-chromatic | 3.1.0 | MIT |
| cytoscape | 3.34.4 | MIT |
| cytoscape-cose-bilkent | 4.1.0 | MIT |
| d3 | 7.9.0 | ISC |
| d3-sankey | 0.12.3 | BSD-3-Clause |
| dagre-d3-es | 7.0.10 | MIT |
| dayjs | 1.11.23 | MIT |
| dompurify | 3.4.17 | (MPL-2.0 OR Apache-2.0) |
| elkjs | 0.9.3 | EPL-2.0 |
| katex | 0.16.47 | MIT |
| khroma | 2.1.0 | none in metadata (field absent) |
| lodash-es | 4.18.1 | MIT |
| mdast-util-from-markdown | 1.3.1 | MIT |
| non-layered-tidy-tree-layout | 2.0.2 | MIT |
| stylis | 4.4.0 | MIT |
| ts-dedent | 2.3.0 | MIT |
| uuid | 9.0.1 | MIT |
| web-worker | 1.5.0 | Apache-2.0 |

### License banners in the bundle

Command: `grep -oF '/*!' dist/mermaid.min.js | wc -l` returns 8 banner openers. A read-only `python3 -I` scan lists each opener with its offset.

1. DOMPurify 3.0.9 (Apache-2.0 and MPL-2.0 text named).
2. js-yaml 4.1.0 (MIT). This package is not a runtime dependency in the metadata.
3. Promises/A+ Thenable (Copyright 2013-).
4. Event object based on jQuery events (MIT).
5. Bezier curve function generator (MIT).
6. Runge-Kutta spring function generator, from Framer.js (MIT).
7. Two openers are Mermaid code comments, not licenses.

The bundle has 6 license banners.

### Texts a distribution needs

1. Confirmed by archive: the MIT text of mermaid (`package/LICENSE`) and of marked (`package/LICENSE.md`).
2. Banner names confirm code from DOMPurify, js-yaml, Thenable, jQuery events, Bezier, and Runge-Kutta. Full license texts for these are NOT VERIFIED: the archive does not contain them.
3. Texts for cytoscape (MIT), katex (MIT), lodash-es (MIT), mdast-util-from-markdown (MIT), sanitize-url (MIT), cose-bilkent (MIT), elkjs (EPL-2.0), and web-worker (Apache-2.0) are NOT VERIFIED. The archive does not contain them.
4. Texts for the 9 dependencies with inclusion NOT VERIFIED are also NOT VERIFIED.
5. The text for khroma is NOT VERIFIED: the metadata has no license field.
6. The implementation card must keep the bundled comments and both package license files.

## Size and change-set result

The worker limit is 500 changed lines.

The selected artifacts require 2,100 lines before first-party changes (marked 6, mermaid 2,029, licenses 65).

The runtime files alone require 2,035 lines.

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
3. The planner must decide on the NOT VERIFIED license texts. The data is in the License findings section.
4. The validator must confirm browser network behavior.
5. P0-F1b2 dashboard fixture approval remains unresolved.
6. E3 remains blocked until these gates pass.

This review does not approve E3.

It does not approve E3 browser behavior.

It does not approve E3, final integration, or remote dependency removal.
