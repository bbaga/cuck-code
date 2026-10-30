'use strict';
// Real-browser smoke check of the dashboard fixture. Exit 0 pass, 1 fail, 3 no browser.
const { startDashboardFixture } = require('./dashboard-browser');
const { openPage } = require('./browser-driver');

const STUBS = 'window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };'
  + 'window.marked = { use() {}, parse: (t) => String(t) };';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(100); }
  return false;
}

async function run() {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    // The page loads marked and mermaid from a CDN and calls them at start-up. The CSP blocks
    // both requests, so stub the globals to let the real page script run.
    page = await openPage(fx.url, { initScript: STUBS });
    const lineVisible = await waitFor(() => page.evaluate(
      `/browser[- ]line/i.test(document.body.innerText)`), 10000);
    const sseReceived = page.requests().includes(`${fx.url}/api/events`);
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
