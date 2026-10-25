# Registry UI video guide

Record one video for each of the six cases below. Use an isolated router and test data. Do not use port 7788 for this router.

## Use the integration validator worktree

Run the tests and save the videos inside the dedicated integration validator worktree. Set `WORKTREE` to its top-level path. If the repository is a nested clone, set `REPO` to the path of the clone inside that worktree. All video paths in evidence requests must be relative to `WORKTREE`.

```sh
WORKTREE=/path/to/integration-validator-worktree
REPO="$WORKTREE/router-prototype" # Use WORKTREE instead if the repo is at its root.
cd "$REPO"
mkdir -p "$WORKTREE/evidence" /tmp/registry-ui-lines
```

Start an isolated router with a free port other than 7788:

```sh
PORT=17788 LINES_DIR=/tmp/registry-ui-lines node server.js
```

Open `http://localhost:17788` in the browser. Use only this router and its storage for test data.

## Playwright prerequisite

The Playwright package and its browser must be available in the environment that runs the recording script. Check before recording:

```sh
node -e "console.log(require.resolve('playwright'))"
npx playwright --version
```

If either check fails, do not assume that Playwright is installed locally. Use the Playwright runtime provided to the integration validator, or ask for that runtime to be made available. Do not add or install a package in this worktree just for recording.

## Record a case

Start a new context for each video. Set `recordVideo` before opening a page. Run this script from `WORKTREE`. Change `fileName` and the case actions for each recording.

```js
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    recordVideo: { dir: path.resolve('evidence') },
  });
  const page = await context.newPage(); // Video recording is enabled before this call.
  await page.goto('http://localhost:17788');
  // Run one case here.
  const video = page.video();
  await context.close(); // Finalize the recording before using its path.
  console.log(await video.path());
  await browser.close();
})();
```

The video is in `WORKTREE/evidence`. Use the path relative to `WORKTREE` when you register it. For a repository nested in the worktree, that path includes the clone directory, for example `router-prototype/evidence/registry-open.webm`. Close the context before registration. The completed path is available from `await video.path()` after close.

## Prepare the data

Use two distinct line IDs, for example `registry-source` and `registry-target`. Create both lines in the isolated router. Keep them in the test storage directory. Use the source line for claims and the target line for requests.

Before the archive case, prepare a completed merge/archive record for the source line by using the normal line workflow. Confirm that the registry displays it before you record. The archive must be visible and must show the source line, merge reference, and status. Do not record an empty archive view as a passing case.

Before the request case, use the source line to open a request addressed to the target line. Use the target line to answer it. Record the request ID and its current revision. Enter that revision in the answer form.

## Six cases

1. **Open the registry.** Open the global registry. Show the claims, requests, and archives sections.
2. **Filter the registry.** Enter a search value or status. Show the filtered rows.
3. **View an archive.** Show the prepared archive row, its source line, merge reference, and status.
4. **Publish a claim.** Publish a claim from `registry-source`. Show the registry after the update.
5. **Open and answer a request.** Open a request from `registry-source` to `registry-target`. Then answer it from the target line using the saved request revision. Show the updated registry.
6. **Replay registry events.** Open the dashboard. Disconnect the browser from the network, then reconnect it. Show the registry refresh after replay.

Use a new context and a separate completed video for every case.

## Register each completed video

Send evidence to the main router at `http://localhost:7788`. Do not send evidence to the isolated router on port 17788. Set `WORKER_ID` to the integration validator worker ID. Use the exact worker ID in the URL. The `useCase` and `file` fields are required. `file` is relative to `WORKTREE`, and must include the nested clone directory when present.

Run one request for each video. Check that each response has a successful HTTP status (201) and an `evidenceId`. Do not report success for a failed request.

```sh
WORKER_ID='<integration-validator-worker-id>'
curl --fail-with-body -sS -X POST "http://localhost:7788/api/protocol/workers/$WORKER_ID/evidence" \
  -H 'Content-Type: application/json' \
  -d '{"useCase":"View an archive","file":"router-prototype/evidence/registry-archive.webm"}'
```

Use `"file":"evidence/registry-archive.webm"` instead when the repository is at the root of `WORKTREE`. Use a distinct `useCase` and file path for each of the six cases. Confirm the response for each registration before you continue.
