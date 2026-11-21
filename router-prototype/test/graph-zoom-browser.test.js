"use strict";
// Real-browser check of the graph zoom on the line Pipeline tab. Skipped when no
// Chrome is available. Set GRAPH_ZOOM_SHOTS=<dir> to save screenshots.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startDashboardFixture } = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");
const { loadBuiltinPipeline } = require("../line-graph");

const ROOT = path.join(__dirname, "..");
const STUBS = "window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };"
  + "window.marked = { use() {}, parse: (t) => String(t) };"
  + "window.__errs = [];"
  + "window.addEventListener('error', (e) => window.__errs.push(String(e.message)));";
const PANE = "document.querySelector('.pipePane')";
const SVG = `${PANE}.querySelector('svg.pipeGraph')`;
const BTN = (label) => `${PANE}.querySelector('button[aria-label="${label}"]')`;

test("pipeline tab: zoom buttons scale the SVG and keep the zoom", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    require("../server").lines.get(fx.lineId).graph = loadBuiltinPipeline("default", fs, ROOT);
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    const shots = process.env.GRAPH_ZOOM_SHOTS;
    if (shots) fs.mkdirSync(shots, { recursive: true });
    await page.setViewport(1100, 1100);
    await page.waitFor("/browser[- ]line/i.test(document.body.innerText)");
    await page.evaluate("[...document.querySelectorAll('button.tabBtn')].find((b) => b.textContent === 'Pipeline').click()");
    await page.waitFor(`${PANE} && !${PANE}.hidden && ${SVG}`);

    const layoutWidth = await page.evaluate(`Number(${SVG}.getAttribute('width'))`);
    assert.equal(await page.evaluate(`${BTN("Reset zoom")}.textContent`), "100%");
    await page.evaluate(`${BTN("Zoom in")}.click()`);
    assert.equal(await page.evaluate(`Number(${SVG}.getAttribute('width'))`), layoutWidth * 1.25);
    assert.equal(await page.evaluate(`${BTN("Reset zoom")}.textContent`), "125%");
    assert.equal(await page.evaluate(`document.querySelectorAll('.pipePane .zoomBar').length`), 1);
    if (shots) await page.screenshot(path.join(shots, "zoom-125.png"));
    if (shots) {
      // The saved zoom applies again after a reload.
      for (const pct of [50, 100, 200]) {
        await page.evaluate(`localStorage.setItem("cuck.pipeZoom.${fx.lineId}", "${pct}")`);
        await page.evaluate("location.reload()");
        await page.waitFor("/browser[- ]line/i.test(document.body.innerText)");
        await page.evaluate("[...document.querySelectorAll('button.tabBtn')].find((b) => b.textContent === 'Pipeline').click()");
        await page.waitFor(`${PANE} && !${PANE}.hidden && ${SVG}`);
        assert.equal(await page.evaluate(`${BTN("Reset zoom")}.textContent`), pct + "%");
        await page.screenshot(path.join(shots, "zoom-" + pct + ".png"));
      }
    }
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
});
