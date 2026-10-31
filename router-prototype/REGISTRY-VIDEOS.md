# Registry UI video guide

This guide records six videos of the work registry UI. Every curl and git command here ran once
against a router on a free port with a temporary `LINES_DIR`. Run all commands from the repository root
in one shell, because the variables carry over between sections. Use `bash` or `zsh`; `jq` must exist.

## 0. Start the router

```bash
PORT=$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')
WORK=$(mktemp -d); mkdir -p "$WORK/lines" "$WORK/bin" "$WORK/origins"
BASE=http://localhost:$PORT; JSON='Content-Type: application/json'
```

The merge verifier accepts only `https://github.com/<owner>/<repo>` remotes. Case 5 uses a local bare
repository, so install a test-only `git` wrapper first. It rewrites `https://github.com/` to the local
`origins` directory and reports the GitHub URL for `git remote get-url origin`. All other git calls run as normal.

```bash
REAL_GIT=$(command -v git)
cat > "$WORK/bin/git" <<EOF
#!/bin/sh
case "\$*" in
  *"remote get-url origin") echo "https://github.com/example/demo.git"; exit 0;;
esac
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="url.file://$WORK/origins/.insteadOf" GIT_CONFIG_VALUE_0="https://github.com/"
exec $REAL_GIT "\$@"
EOF
chmod +x "$WORK/bin/git"
```

The isolated router starts a planner agent when a line gets a request notice. Stub the agent CLIs so no
real agent runs against `$WORK`:

```bash
for h in vibe pi codex claude; do printf '#!/bin/sh\nexit 0\n' > "$WORK/bin/$h"; chmod +x "$WORK/bin/$h"; done
```

Start the router in the background and wait for it:

```bash
start_router() {
  PATH="$WORK/bin:$PATH" PORT=$PORT LINES_DIR="$WORK/lines" node router-prototype/server.js >>"$WORK/router.log" 2>&1 &
  SERVER_PID=$!
  for i in $(seq 1 60); do curl -sf -o /dev/null "$BASE/api/lines" && return 0; sleep 0.5; done
  echo "router did not start" >&2; return 1
}
start_router
```

At the end, stop it with `kill "$SERVER_PID"` and run `rm -rf "$WORK"` (section 10).

## 1. Seed data (HTTP API only)

The create-line API returns `id`. Use ids in all registry calls, never names.

```bash
mkline() { curl -s -X POST "$BASE/api/lines" -H "$JSON" -d "{\"name\":\"$1\"}" | jq -r .id; }
LINE_A=$(mkline "Line A"); LINE_B=$(mkline "Line B")
LINE_D=$(mkline "Line D"); LINE_M=$(mkline "Line M")
echo "$LINE_A $LINE_B $LINE_D $LINE_M"
hex() { printf "$1%.0s" $(seq 1 40); }      # valid 40-character lowercase hex commit
claim() { # line-id title branch commit key
  curl -s -X POST "$BASE/api/registry/lines/$1/claims" -H "$JSON" \
    -d "{\"title\":\"$2\",\"repo\":\"demo\",\"branch\":\"$3\",\"commit\":\"$4\",\"status\":\"active\",\"idempotencyKey\":\"$5\"}" | jq -r .claim.id
}
```

Seed for case 2 and case 3: line A owns one claim.

```bash
CLAIM_A=$(claim "$LINE_A" "Shared CSV parser" feature/parser "$(hex a)" seed-a)
```

Seed for case 4: line D owns a claim and has an open request to line A.

```bash
claim "$LINE_D" "Doomed claim" feature/doomed "$(hex d)" seed-d
curl -s -X POST "$BASE/api/registry/lines/$LINE_D/requests" -H "$JSON" \
  -d "{\"targetLineId\":\"$LINE_A\",\"subject\":\"Doomed ask\",\"text\":\"Line D asks line A\",\"idempotencyKey\":\"seed-d-req\"}" | jq -r .request.id
```

Seed for case 5: a bare origin, a clone, one commit pushed to `main`, and the repo registered on line M.
The registered name `demo` must equal the claim `repo` field.

```bash
git init -q --bare --initial-branch=main "$WORK/origins/example/demo.git"
git clone -q "$WORK/origins/example/demo.git" "$WORK/demo-clone" 2>/dev/null
git -C "$WORK/demo-clone" checkout -q -b main
git -C "$WORK/demo-clone" -c user.name=Demo -c user.email=demo@example.com commit -q --allow-empty -m "Add merged feature"
git -C "$WORK/demo-clone" push -q origin main
MERGED_COMMIT=$(git -C "$WORK/demo-clone" rev-parse HEAD)
curl -s -X POST "$BASE/api/protocol/lines/$LINE_M/repos" -H "$JSON" \
  -d '{"name":"demo","url":"https://github.com/example/demo.git"}'
CLAIM_M=$(claim "$LINE_M" "Merged feature" main "$MERGED_COMMIT" seed-m)
```

The repo call returns `{"name":"demo","path":...}` with status 201. The claim stays `active` until case 5.

## 2. Selectors

| Selector | Meaning | Defined in |
| --- | --- | --- |
| `#registryBtn` | Sidebar button that opens or closes the dashboard (`aria-pressed`) | `web/index.html` |
| `#registry` (`aria-label="Registry"`) | Dashboard section | `web/index.html` |
| `.lineentry[data-line-id="<id>"]` | Sidebar entry of one line. Click it to select the line | `web/index.html` |
| `.card[data-line-id="<id>"]` | The card of one line. Scope every line control to it | `web/index.html` |
| card button `Work` / `Line` | Tabs of the line (class `tabBtn`, no id) | `web/index.html` |
| card `.deleteBtn` | Delete button. First click shows `Sure?`, second click deletes | `web/index.html` |
| card `.workPane` | Work view of the line | `web/index.html`, `web/registry-line.js` |
| `.workPane li[data-claim-id="<id>"]`, `.workPane li[data-request-id="<id>"]` | One claim or request row. Scope row buttons to it | `web/registry-line.js` |
| `.workPane` labels (exact) `Repo (free text)`, `Title`, `Summary`, `Tags (comma list)`, `Branch`, `Commit (40 hex)`, `Contract`, `Status` | Publish form fields (use `getByLabel`) | `web/registry-line.js` |
| `.workPane` buttons `Publish`, `Send request`, `Accept`, `Decline`, `Mark fulfilled`, `Fulfil` | Work view actions (`getByRole('button')`) | `web/registry-line.js` |
| `.workPane label` with text starting `Target line` or `Claim reference (optional)`, then `select`; label `Subject` | Request form fields. The select labels also hold the option text, so exact `getByLabel` fails |  `web/registry-line.js` |
| `.workPane textarea` | The `Text` field of the request form (only one textarea exists; do not use `getByLabel('Text')`) | `web/registry-line.js` |
| request row `form:has(button:text-is("Fulfil")) select` | The `Claim` select of the fulfil form (its label text includes the option text) | `web/registry-line.js` |
| `.workPane h3:text-is("My claims") + div`, `... "Incoming requests") + div`, `... "Outgoing requests") + div` | The list box of each section (the `ul` is inside it) | `web/registry-line.js` |
| `.workMsg` (`role=alert`) | Work view error text | `web/registry-line.js` |
| `#registry .regTabs button` `Claims` / `Archive` (`aria-pressed`) | Dashboard tabs | `web/registry-ui.js` |
| `[aria-label="Status filter"]`, `[aria-label="Search claims"]` | Dashboard status select (`current`, `all`, `stale`, ...) and search box | `web/registry-ui.js` |
| `[aria-label="Owner line filter"]`, `[aria-label="Repository filter"]` | Dashboard filters | `web/registry-ui.js` |
| `#registry .regConn` (`role=status`) | `live`, `reconnecting`, or `offline` | `web/registry-ui.js` |
| `#registry > .regError` (`role=alert`) | Top error line: `Registry error: ...` text. Do not use `#registry .regError`: detail rows and the events panel also use that class | `web/registry-ui.js` |
| `#registry .regSummary` (first) | Count line: `active: 1 \| ... \| archive: 1 \| revision: N` | `web/registry-ui.js` |
| `#registry .regSummary` (second) | `By owner line: ... \|\| By repo: ...` | `web/registry-ui.js`, `web/registry-ui-extra.js` |
| `#registry .regTableWrap` (`table` or `p`) | Claims or archive table; `p` shows `Could not load claims` | `web/registry-ui.js` |
| `#registry .regTableWrap button` `Details` | Detail row (stale reason, merge fields) | `web/registry-ui.js` |
| `#registry .regEvents p.regError` | Events panel error text, for example `Unavailable` | `web/registry-ui.js` |
| `#registry .regTableWrap tr` with first `td` text starting `<title>` | One dashboard row. Titles in this guide are unique | `web/registry-ui.js` |
| `#registry .regEvents li` | Recent events: `<time> <type> <subject>` | `web/registry-ui.js`, `web/registry-ui-extra.js` |

The dashboard shows a deleted owner as `<line name or id> (deleted owner)` in the Owner line column.
The summary breakdown shows `<line id> (deleted line)`.

## 3. Record each case as a video

Use one browser context per case, so each case gives one `.webm` file. Use an absolute directory.
Keep the directory inside your worker worktree, because the evidence API accepts only files in the worktree.

```js
const { chromium } = require('playwright');
const dir = '/ABSOLUTE/PATH/TO/WORKTREE/evidence';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 },
  recordVideo: { dir, size: { width: 1280, height: 800 } } });
const page = await ctx.newPage();
await page.goto(process.env.BASE);          // BASE = http://localhost:<port>
// ... steps of one case ...
const file = await page.video().path();     // read the path before closing
await ctx.close();                          // closing the context finalizes the video
```

Slow the steps down with `page.waitForTimeout(1000)` between actions, so the video shows each state.
Rename `file` to `case-<n>.webm` after `ctx.close()`. Then register it. Use the evidence worker id and a
path relative to the worktree. The file must be larger than 1 KB.

```bash
curl -s -X POST "$BASE/api/protocol/workers/$WORKER_ID/evidence" -H "$JSON" \
  -d '{"useCase":"Case 1: publish a claim and see it in the Registry","file":"evidence/case-1.webm"}'
```

The answer is 201 with `{evidenceId, attemptId}`. Use one `useCase` title per case.

Run the six cases in order, on one router, without a reset. Earlier cases leave lines, claims and
requests behind, so every locator must match exactly one element. Follow these rules:

1. Find a line by its id: `.lineentry[data-line-id="$LINE_A"]` and `.card[data-line-id="$LINE_A"]`.
   Never find a line by its name, and never use `.card:visible`.
2. Scope each line control to that card: `card.getByRole('button', { name: 'Work', exact: true })`,
   then `card.locator('.workPane')` for fields and buttons.
3. Scope each request button to its row: `workPane.locator('li[data-request-id="<id>"]')`.
   A page-wide `Accept`, `Mark fulfilled` or `Fulfil` locator is not allowed.
4. Before each click, fill or select, check that the locator matches exactly one element:

```js
async function one(loc, what) {
  await loc.first().waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
  const n = await loc.count();
  if (n !== 1) throw new Error(`${what}: expected 1 match, got ${n}`);
  return loc;
}
const card = (id) => page.locator(`.card[data-line-id="${id}"]`);
async function openWork(id) {
  await (await one(page.locator(`.lineentry[data-line-id="${id}"]`), 'entry')).click();
  await (await one(card(id).getByRole('button', { name: 'Work', exact: true }), 'Work')).click();
  return card(id).locator('.workPane');
}
const section = (w, h) => w.locator(`h3:text-is("${h}") + div`);
```

Pass the line ids to the script as environment variables. To open the dashboard, click `#registryBtn`.

## 4. Case 1: publish a claim, see it on the dashboard

Setup: sections 0 and 1. Line A must exist.

1. `w = openWork($LINE_A)`. Expect `section(w, 'My claims')` to list `Shared CSV parser`.
2. In `w`, fill (`getByLabel(..., { exact: true })`) `Repo (free text)` with `demo`, `Title` with `Parser v2`, `Branch` with `feature/parser-v2`,
   and `Commit (40 hex)` with `cccccccccccccccccccccccccccccccccccccccc`. Leave `Status` as `active`.
3. Click `w.getByRole('button', { name: 'Publish', exact: true })`.
4. Expect `Parser v2 · active · rev 1 · feature/parser-v2 · cccccccc` in `My claims`. The form fields clear.
5. Click `#registryBtn`. Expect `#registry .regConn` to read `live`.
6. Expect a row `Parser v2` with status `active` and owner `Line A` in the table.

## 5. Case 2: duplicate discovery (advisory only)

Setup: sections 0 and 1 (`Shared CSV parser` owned by line A).

1. `w = openWork($LINE_B)`. Expect `No claims yet.` under `My claims`.
2. Click `#registryBtn`.
3. Type `parser` into `Search claims`. Wait about 1 second (the box waits 300 ms).
4. Expect the table to show `Shared CSV parser`, owner `Line A`. Click `Details` inside that row only.
5. Expect the Detail list to show `Branch` `feature/parser`. Nothing blocks line B: the result is advice only.
6. Select `Line B` in `Owner line filter`. Expect `No claims match`.

## 6. Case 3: cross-line request

Setup: sections 0 and 1. Lines A and B exist, and line A owns `Shared CSV parser`.

1. `wb = openWork($LINE_B)`. In `wb`, select the value `$LINE_A` in `label` `^Target line` `select`.
   Wait until the `^Claim reference (optional)` select lists `Shared CSV parser`. Choose it.
2. In `wb`, fill `Subject` with `Need the parser` and `textarea` with `Please share the parser branch`.
   Click `wb.getByRole('button', { name: 'Send request', exact: true })`.
3. `out = section(wb, 'Outgoing requests').locator('li[data-request-id]', { hasText: 'Need the parser' })`.
   Expect it to read `Need the parser · Line A · open · rev 1`. Save `RID = out.getAttribute('data-request-id')`.
4. `wa = openWork($LINE_A)`. `inc = section(wa, 'Incoming requests').locator('li[data-request-id="' + RID + '"]')`.
   Check `one(inc)`. Expect `Need the parser · Line B · open`.
5. Check `one(inc.getByRole('button', { name: 'Accept', exact: true }))`, then click it. Expect `inc` to read `accepted`.
6. Click `Mark fulfilled` in `inc`. Choose `Shared CSV parser` in `inc.locator('form:has(button:text-is("Fulfil")) select')`.
   Click `Fulfil` in `inc`.
7. Expect `inc` to read `fulfilled`.
8. `wb = openWork($LINE_B)`. Expect `li[data-request-id="<RID>"]` under `Outgoing requests` to read `Need the parser · Line A · fulfilled`.
   Line B has no buttons on outgoing rows.

## 7. Case 4: line deletion

Setup: sections 0 and 1. Line D has `Doomed claim` and an open request `Doomed ask` to line A.

1. Click `#registryBtn`. Select `all` in `Status filter`. Expect `Doomed claim` as `active`, owner `Line D`.
2. Click `#registryBtn` again. Click `.lineentry[data-line-id="$LINE_D"]`. Click `.card[data-line-id="$LINE_D"] .deleteBtn` twice.
   The first click shows `Sure?`. Click the second within 4 seconds.
3. Expect `.lineentry[data-line-id="$LINE_D"]` to leave the sidebar.
4. `wa = openWork($LINE_A)`. Expect the `li[data-request-id]` with text `Doomed ask` to read `Doomed ask · <line D id> · open · orphaned · rev 2` under
   `Incoming requests`. The row has no `Accept` button. The name shows as the id because the line is gone.
5. Click `#registryBtn`. Select `stale` in `Status filter` (or keep `all`).
6. Expect the row `Doomed claim` with status `stale: owner-gone` and owner `<line D id> (deleted owner)`.
7. Expect `.regEvents` to list `claim.stale` and `request.orphaned`.
   The second `.regSummary` shows `<line D id> (deleted line): 1`.

## 8. Case 5: merge visibility with the real verifier

Setup: sections 0 and 1, including the git commands. Claim `Merged feature` is `active` on line M.
Do this case soon after the router start. The background merge sweep (first run 60 seconds after start)
can archive the claim before your manual refresh. Then the refresh returns `already_merged`.
That result is also correct. The Archive and `claim.merged` checks below stay the same.

1. Click `#registryBtn`. Expect `Merged feature` in the Claims tab with `Merge check` `never checked`.
2. Run the refresh (the router checks the commit in the registered repo; the UI has no refresh button):

   ```bash
   curl -s -X POST "$BASE/api/registry/claims/$CLAIM_M/refresh" -H "$JSON" -d '{}'
   ```

   Expect `{"result":{"ok":true,"merged":true,...}}`.
3. Expect `Merged feature` to leave the Claims table without a reload. The first `.regSummary` shows `archive: 1`.
4. Expect `.regEvents` to list `claim.merged` first.
5. Click `Archive`. Expect the row `Merged feature` with Repository `https://github.com/example/demo.git`,
   Target branch `main`, Strategy `merge`, PR `-`, Commit the first 8 characters of `$MERGED_COMMIT`.

## 9. Case 6: live update and recovery

Setup: sections 0 and 1.

1. Click `#registryBtn`. Expect `live` in `.regConn`.
2. Publish a claim through the API. Expect the row `Live claim` to appear within 2 seconds, with no reload:

   ```bash
   claim "$LINE_A" "Live claim" feature/live "$(hex b)" live-1
   ```

3. Stop the router: `kill "$SERVER_PID"`. Expect `.regConn` to show `reconnecting`, then `offline`.
4. Wait up to 20 seconds for the next poll. Expect the table area to read `Could not load claims`,
   `#registry > .regError` to read `Registry error: ...`, and the breakdown to clear. Expect `#registry .regEvents p.regError` to read `Unavailable`.
5. Start it again with the same port and directory: `start_router`.
6. Expect `.regConn` to return to `live` (within about 20 seconds). Expect the table, breakdown and
   events to fill again, and `#registry > .regError` to clear.

## 10. Finish

```bash
kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null
rm -rf "$WORK"
```

Register each of the six videos (section 3) before you remove `$WORK`. Keep the video files in the worktree
`evidence` directory, not in `$WORK`.
