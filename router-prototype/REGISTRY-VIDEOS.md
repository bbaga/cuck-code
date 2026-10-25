# Registry UI video guide

Use this guide to record the six registry UI cases. Use a router that is separate from the normal router. Do not use port 7788.

## Start an isolated router

Run these commands from the repository root. Use a port that is free on your machine.

```sh
mkdir -p /tmp/registry-ui-lines
PORT=17788 LINES_DIR=/tmp/registry-ui-lines node router-prototype/server.js
```

Open `http://localhost:17788` in Playwright. Use test data in this router only. Do not point this router at your normal `lines` directory.

## Record one case

Make one recording for each case below. Create the video directory before you start. Start a new browser context for each case. Set `recordVideo` before you open a page.

```js
const path = require('node:path');
const { chromium } = require('playwright');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  recordVideo: { dir: path.resolve('evidence') },
});
const page = await context.newPage(); // Open the page only after recordVideo is set.
await page.goto('http://localhost:17788');
// Run one case here. Use a new context for the next case.
const video = page.video();
await context.close(); // This completes and saves the video.
const videoPath = await video.path();
console.log(videoPath);
await browser.close();
```

Create the `evidence` directory first. Call `video.path()` after `context.close()`. The returned path is the completed video file. Keep each video under `evidence/` in the worker worktree. Use a clear file name, such as `evidence/registry-archive.webm`.

## Six cases

1. **Open the registry.** Select the global registry view. Show its claims, requests, and archives.
2. **Filter the registry.** Enter a search value or status filter. Show the filtered rows.
3. **View an archive.** Show an archive row with its source line, merge reference, and status.
4. **Publish a claim.** Submit a claim from a source line. Show the updated registry.
5. **Open and answer a request.** Submit an inbound request, then answer it from its target line. Use the request revision in the answer form.
6. **Replay registry events.** Open the dashboard, disconnect the browser from the network, then reconnect it. Show the registry refresh after event replay.

Use valid line IDs and request revisions from the isolated router. Do not use real or shared line data.

## Register each video

Set `WORKER_ID` to the ID of the worker that ran the case. Send one request for each completed video. The `useCase` field must name the case. The `file` field must be the path to that case's video, relative to the worker worktree.

```sh
curl -s -X POST "http://localhost:17788/api/protocol/workers/$WORKER_ID/evidence" \
  -H 'Content-Type: application/json' \
  -d '{"useCase":"Open the registry","file":"evidence/registry-open.webm"}'
```

The required fields are `worker ID` in the URL, `useCase`, and `file`. Use a separate evidence request for each of the six cases. Register a video only after closing its browser context.
