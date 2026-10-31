"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startDashboardFixture } = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");

const STUBS = "window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };"
  + "window.marked = { use() {}, parse: (t) => String(t) };";
const HOSTILE = "# Head\n\n- item\n\n<script>window.pwned=1</script><img src=x onerror=\"window.pwned=1\">\n\n[bad](javascript:window.pwned=1)";

test("real dashboard renders assistant Markdown and keeps user text literal", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    await page.waitFor("/browser[- ]line/i.test(document.body.innerText)");
    const res = await fetch(`${fx.url}/api/lines/${fx.lineId}/prompts`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: HOSTILE }) });
    assert.equal(res.status, 202);
    fx.controls.emitOutput(HOSTILE);
    await page.waitFor("!!document.querySelector('.transcript .assistant h1')");
    const r = await page.evaluate(`(() => {
      const a = document.querySelector('.transcript .assistant');
      const u = document.querySelector('.transcript .user');
      return { pwned: window.pwned, heading: !!a.querySelector('h1'), list: !!a.querySelector('ul li'),
        bad: a.querySelectorAll('script,img,iframe,[onerror],a[href^="javascript:"]').length,
        userText: u.textContent, userKids: u.querySelectorAll(':scope > :not(.ts)').length };
    })()`);
    assert.equal(r.pwned, undefined);
    assert.ok(r.heading && r.list);
    assert.equal(r.bad, 0);
    assert.ok(r.userText.includes("<script>window.pwned=1</script>"));
    assert.equal(r.userKids, 0);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
});
