# Registry UI video guide

Record a separate video for each of the six cases below. Use an isolated router and test data. Do not use port 7788 for the isolated router.

## Use the integration validator worktree

Save videos inside the integration validator's dedicated worktree. In this setup, the repository clone directory is `cuck-code`. Set `WORKTREE` to the integration validator worktree root. Save videos in the absolute directory `$WORKTREE/cuck-code/evidence`.

```sh
WORKTREE=/absolute/path/to/integration-validator-worktree
REPO="$WORKTREE/cuck-code"
mkdir -p "$WORKTREE/cuck-code/evidence" /tmp/registry-ui-lines
cd "$REPO"
```

Start an isolated router with an available port other than 7788:

```sh
PORT=17788 LINES_DIR=/tmp/registry-ui-lines node router-prototype/server.js
```

Open `http://localhost:17788` in the browser. Use only this router and its storage for test data.

## Record with the Playwright MCP browser

Use the available Playwright MCP browser runtime. This option does not need a local Playwright package. Call `browser_run_code_unsafe` with a function that accepts `page`. The existing page provides a browser through `page.context().browser()`. Create a new context with `recordVideo` set to the absolute evidence directory before opening a page in that context.

Run this code once per case. Replace `CASE_FILE` and the case actions each time. The browser runtime must be able to write to the validator worktree path.

```js
async (page) => {
  const browser = page.context().browser();
  const evidenceDir = '/absolute/path/to/integration-validator-worktree/cuck-code/evidence';
  const context = await browser.newContext({
    recordVideo: { dir: evidenceDir },
    viewport: { width: 1280, height: 900 },
  });
  const recordingPage = await context.newPage(); // Set recordVideo before this call.
  await recordingPage.goto('http://localhost:17788');
  // Run exactly one registry case here.
  const video = recordingPage.video();
  await context.close(); // Finish the recording before requesting its path.
  const absoluteVideoPath = await video.path();
  return { absoluteVideoPath };
}
```

Use the returned absolute path to confirm the completed video. Close each context before obtaining its video path. The file path for evidence registration is relative to `WORKTREE`; for this clone it is `cuck-code/evidence/<file>.webm`. Do not use a path relative to `REPO`.

If you choose a local Playwright script instead, the `playwright` package and its browser must be available in that runtime. Check with `node -e "console.log(require.resolve('playwright'))"` and `npx playwright --version`. If either check fails, use the MCP option above. Do not assume that a local package is installed, and do not install one just for these recordings.

## Prepare the data

Use two different line IDs, for example `registry-source` and `registry-target`. Create both lines in the isolated router. Use the source line for claims and the target line for requests.

Before recording the archive case, use the normal line workflow to create a completed merge/archive record for `registry-source`. Open the global registry and confirm that its archive row is visible. The row must show the source line, merge reference, and status. Do not record an empty archive view as a passing case.

Before the request case, open a request from `registry-source` to `registry-target`. Record its request ID and current revision. Answer it from the target line with that revision.

## Six cases

1. **Open the registry.** Open the global registry. Show the claims, requests, and archives sections.
2. **Filter the registry.** Enter a search value or status. Show the filtered rows.
3. **View an archive.** Show the prepared archive row, its source line, merge reference, and status.
4. **Publish a claim.** Publish a claim from `registry-source`. Show the updated registry.
5. **Open and answer a request.** Open a request from `registry-source` to `registry-target`. Answer it from the target line using the saved request revision. Show the updated registry.
6. **Replay registry events.** Open the dashboard. Disconnect the browser from the network, then reconnect it. Show the registry refresh after event replay.

Use one new recording context and one completed video for each case.

## Register each completed video

Send evidence to the main router at `http://localhost:7788`. Do not send evidence to the isolated router on port 17788. Set `WORKER_ID` to the exact integration validator worker ID. The request must use that ID in the URL. Its `useCase` field must name the case. Its `file` field must be relative to the worker worktree and include the `cuck-code` clone directory.

Evidence registration uses **POST**. A GET probe can return 404; that does not test registration. Send one POST for each completed video. Check each response. Success requires HTTP status 201 and an `evidenceId` in the response.

```sh
WORKER_ID='<exact-integration-validator-worker-id>'
curl --fail-with-body -sS -X POST "http://localhost:7788/api/protocol/workers/$WORKER_ID/evidence" \
  -H 'Content-Type: application/json' \
  -d '{"useCase":"View an archive","file":"cuck-code/evidence/registry-archive.webm"}'
```

Use a distinct `useCase` and file path for each case. Confirm every registration response before you report the videos as evidence.
