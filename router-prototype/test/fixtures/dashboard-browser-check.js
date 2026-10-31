'use strict';
const { startDashboardFixture } = require('./dashboard-browser');
const { openPage } = require('./browser-driver');

const STUBS = 'window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };'
  + 'window.marked = { use() {}, parse: (t) => String(t) };';
async function run() {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    // The page loads marked and mermaid from a CDN and calls them at start-up. The CSP blocks
    // both requests, so stub the globals to let the real page script run.
    page = await openPage(fx.url, { initScript: STUBS });
    const lineVisible = await page.waitFor('/browser[- ]line/i.test(document.body.innerText)')
      .then(() => true, () => false);
    // Live update: a prompt starts the fake child. Its output must reach the open page without a reload.
    let sseReceived = false;
    if (lineVisible) {
      const marker = `live-update-${process.pid}-${Date.now()}`;
      const res = await fetch(`${fx.url}/api/lines/${fx.lineId}/prompts`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'check' }) });
      if (res.status === 202) {
        fx.controls.emitOutput(marker);
        sseReceived = await page.waitFor(`document.body.innerText.includes(${JSON.stringify(marker)})`)
          .then(() => true, () => false);
      }
    }
    // A request that the CSP blocked never left the machine. Only unblocked remote requests fail.
    const blocked = new Set(page.blocked());
    const outside = page.requests().filter((u) => !u.startsWith(fx.url) && !u.startsWith('data:'));
    const remote = outside.filter((u) => !blocked.has(u));
    return { browser: page.browser, url: fx.url, lineVisible, requestCount: page.requests().length,
      remoteRequests: remote, blockedRemote: outside.filter((u) => blocked.has(u)), sseReceived };
  } finally {
    if (page) await page.close();
    await fx.close();
  }
}

if (require.main === module) {
  run().then((result) => {
    console.log(JSON.stringify(result));
    process.exit(result.lineVisible && result.remoteRequests.length === 0 && result.sseReceived ? 0 : 1);
  }).catch((err) => {
    if (err.code === 'BROWSER_UNAVAILABLE') { console.log('BROWSER_UNAVAILABLE'); process.exit(3); }
    console.error(err.message); process.exit(1);
  });
}
module.exports = { run };
