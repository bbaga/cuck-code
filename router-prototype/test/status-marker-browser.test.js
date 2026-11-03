"use strict";
// Real-browser check: the line markers (sidebar entry and card header) keep showing "running" while
// implementors or validators run after the planner went idle. The planner node itself shows only the
// planner state. Skipped when no Chrome is available.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startDashboardFixture } = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");

const STUBS = "window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };"
  + "window.marked = { use() {}, parse: (t) => String(t) };"
  + "window.__errs = [];"
  + "window.addEventListener('error', (e) => window.__errs.push(String(e.message)));";

const worker = (id, name, role, status, extra = {}) => ({ id, name, role, kind: "standard", status, persona: "backend",
  repo: "api", branch: "b/" + name, runGeneration: 1, transcript: [], children: [], ...extra });

async function markers(t, seedWorkers) {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    const line = require("../server").lines.get(fx.lineId);
    for (const w of seedWorkers) line.workers.set(w.id, w);
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    await page.setViewport(1100, 900);
    await page.waitFor("/browser[- ]line/i.test(document.body.innerText)");
    await page.waitFor("document.querySelectorAll('.gnode').length >= " + (seedWorkers.length + 1));
    const out = await page.evaluate(`({
      status: ${JSON.stringify(line.status)},
      entry: document.querySelector('.lineentry .dot').className,
      entryLabel: document.querySelector('.lineentry .dot').getAttribute('aria-label'),
      header: [...document.querySelectorAll('.dot')].filter((d) => !d.closest('.lineentry') && !d.closest('.gnode')).map((d) => d.className),
      planner: document.querySelector('.gnode.planner .dot').className,
      errs: window.__errs })`);
    assert.deepEqual(out.errs, []);
    return out;
  } finally {
    if (page) await page.close();
    await fx.close();
  }
}

test("the line markers show running while workers run and the planner is idle", async (t) => {
  const out = await markers(t, [worker("i1", "impl", "implementor", "running"), worker("v1", "impl-val", "validator", "running", { validates: "i1" })]);
  if (!out) return;
  assert.match(out.entry, /marker-running/, "sidebar entry: " + out.entry);
  assert.match(out.entryLabel, /^Running: 2 workers are active$/);
  assert.ok(out.header.some((c) => /marker-running/.test(c)), "card header: " + out.header.join(" | "));
  assert.match(out.planner, /marker-green/, "the planner node shows the planner only: " + out.planner);
});

test("the line markers show idle when no worker runs", async (t) => {
  const out = await markers(t, [worker("i1", "impl", "implementor", "completed"), worker("v1", "impl-val", "validator", "completed", { validates: "i1", verdict: "pass" })]);
  if (!out) return;
  assert.match(out.entry, /marker-green/, "sidebar entry: " + out.entry);
  assert.doesNotMatch(out.entry, /marker-running/);
  assert.match(out.planner, /marker-green/);
});
