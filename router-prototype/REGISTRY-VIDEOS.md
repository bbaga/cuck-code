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

Run this code once per case. Replace the case actions each time. The browser runtime must be able to write to the validator worktree path. Use the exact selectors listed below. Always open the registry with `#registryToggle`, wait for `#registry` to be visible, and only then use `#registryQuery` or `#registryFilter`.

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

## Prepare repeatable test data

Create two lines named `registry-source` and `registry-target` in the isolated router. To create a line without an app harness, POST JSON to `http://localhost:17788/api/lines`, for example:

```sh
curl --fail-with-body -sS -X POST http://localhost:17788/api/lines \\
  -H 'Content-Type: application/json' -d '{"name":"registry-source"}'
curl --fail-with-body -sS -X POST http://localhost:17788/api/lines \\
  -H 'Content-Type: application/json' -d '{"name":"registry-target"}'
```

Use the UI to publish a claim from `registry-source`. The exact selectors are `form#claimForm`, `form#claimForm input[name="lineId"]`, `form#claimForm input[name="claim"]`, and `form#claimForm button`. Fill the line ID with `registry-source` and enter a distinct claim.

Use the UI to open a request. The exact selectors are `form#requestForm`, `form#requestForm input[name="lineId"]`, `form#requestForm input[name="targetLineId"]`, `form#requestForm input[name="text"]`, and `form#requestForm button`. Set the source to `registry-source` and target to `registry-target`. Save the returned request ID and revision. Answer it with `form#answerForm` using `input[name="lineId"]` = `registry-target`, plus its request ID, revision, and answer text.

Before the archive case, complete a merge/archive for `registry-source` through the normal line workflow. Open the registry and confirm a visible archive row with the source line, merge reference, and status. Do not record an empty archive as a pass.

## Six cases and exact UI selectors

For cases 1, 2, 3, 4, and 6, open the registry using `#registryToggle`, then wait for `#registry` to be visible. For example, use `await recordingPage.locator('#registryToggle').click(); await recordingPage.locator('#registry').waitFor({ state: 'visible' });`.

1. **Open the registry.** Click `#registryToggle`; wait for `#registry`; show `#registryContent` and the headings and rows.
2. **Filter the registry.** Open and wait for `#registry` first. Fill `#registryQuery` or `#registryFilter`, then click `#registryRefresh`. Show `#registryContent`.
3. **View an archive.** Open and wait for `#registry` first. In `#registryContent`, show the archive row (`.registry-row`) with its source line, merge reference, and status.
4. **Publish a claim.** Fill `form#claimForm input[name="lineId"]` and `form#claimForm input[name="claim"]`; submit with `form#claimForm button`. Set line ID to `registry-source`, then show the updated `#registryContent` after opening the registry.
5. **Open and answer a request.** Fill `form#requestForm input[name="lineId"]`, `form#requestForm input[name="targetLineId"]`, and `form#requestForm input[name="text"]`; submit with `form#requestForm button`. Then fill `form#answerForm input[name="lineId"]`, `form#answerForm input[name="requestId"]`, `form#answerForm input[name="revision"]`, and `form#answerForm input[name="text"]`; submit with `form#answerForm button`. Use target line `registry-target` and the saved request ID and revision.
6. **Replay registry events.** Open and wait for `#registry`. Disconnect and reconnect the browser network. Show the resulting refresh in `#registryContent`.

Use one new recording context and one completed video for each case. Register each completed video and check its evidence ID before you record the next case.

## Register each completed video

Send evidence to the main router at `http://localhost:7788`. Do not send evidence to the isolated router on port 17788. Set `WORKER_ID` to the exact integration validator worker ID. The request must use that ID in the URL. Its `useCase` field must name the case. Its `file` field must be relative to the worker worktree and include the `cuck-code` clone directory.

Evidence registration uses **POST**. A GET probe can return 404; that does not test registration. Send one POST for each completed video. Check each response. Success requires HTTP status 201 and an `evidenceId` in the response.

```sh
WORKER_ID='<exact-integration-validator-worker-id>'
curl --fail-with-body -sS -X POST "http://localhost:7788/api/protocol/workers/$WORKER_ID/evidence" \
  -H 'Content-Type: application/json' \
  -d '{"useCase":"View an archive","file":"cuck-code/evidence/registry-archive.webm"}'
```

Use a distinct `useCase` and file path for each case. Confirm every registration response and save its `evidenceId` before you start the next case. Do not batch registrations after all recordings.
