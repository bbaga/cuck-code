"use strict";
// Real-browser check of the Pipeline pane resize. Skipped when no Chrome is available.
// Set PIPE_RESIZE_SHOTS=<dir> to save screenshots.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startDashboardFixture } = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");
const { loadBuiltinPipeline } = require("../line-graph");

const ROOT = path.join(__dirname, "..");
const STUBS = "window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };"
  + "window.marked = { use() {}, parse: (t) => String(t) };";
const PANE = "document.querySelector('.pipePane')";
const HANDLE = "document.querySelector('.pipeRow .resizeHandleX')";

async function openPipeline(page) {
  await page.waitFor("/browser[- ]line/i.test(document.body.innerText)");
  await page.evaluate("[...document.querySelectorAll('button.tabBtn')].find((b) => b.textContent === 'Pipeline').click()");
  await page.waitFor(`${PANE} && !${PANE}.hidden`);
}
const width = (page) => page.evaluate(`${PANE}.getBoundingClientRect().width`);
const key = (page, k) => page.evaluate(
  `${HANDLE}.dispatchEvent(new KeyboardEvent("keydown", { key: "${k}", bubbles: true, cancelable: true }))`);

test("pipeline pane: handle resizes by keyboard, persists, resets", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    require("../server").lines.get(fx.lineId).graph = loadBuiltinPipeline("default", fs, ROOT);
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    const shots = process.env.PIPE_RESIZE_SHOTS;
    if (shots) fs.mkdirSync(shots, { recursive: true });
    await page.setViewport(1400, 1000);
    await page.evaluate("localStorage.clear()");
    await openPipeline(page);
    assert.equal(await page.evaluate(`${HANDLE}.getAttribute("aria-orientation")`), "vertical");
    assert.equal(await page.evaluate(`${HANDLE}.getAttribute("aria-label")`), "Resize pipeline pane");
    const start = await width(page);
    assert.ok(start <= 720);
    if (shots) await page.screenshot(path.join(shots, "pipe-default.png"));

    for (let i = 0; i < 4; i++) await key(page, "ArrowRight");
    assert.equal(await width(page), start + 64);
    await key(page, "ArrowLeft");
    assert.equal(await width(page), start + 48);
    if (shots) await page.screenshot(path.join(shots, "pipe-wider.png"));
    const storeKey = `cuck.pipeWidth.${fx.lineId}`;
    assert.equal(await page.evaluate(`localStorage.getItem("${storeKey}")`), String(Math.round(start + 48)));

    await page.evaluate("location.reload()");
    await openPipeline(page);
    assert.equal(await width(page), Math.round(start + 48));

    for (let i = 0; i < 60; i++) await key(page, "ArrowLeft");
    assert.equal(await width(page), 360);
    if (shots) await page.screenshot(path.join(shots, "pipe-narrower.png"));
    // "Fit graph to width" must fit the graph in the narrow box.
    await page.waitFor(`${PANE}.querySelector('svg.pipeGraph')`);
    await page.evaluate(`${PANE}.querySelector('button[aria-label="Fit graph to width"]').click()`);
    const fit = await page.evaluate(`({
      svg: ${PANE}.querySelector('svg.pipeGraph').getBoundingClientRect().width,
      box: ${PANE}.querySelector('.pipeGraphBox').clientWidth })`);
    assert.ok(fit.svg <= fit.box + 1, `svg ${fit.svg} wider than box ${fit.box}`);

    await page.evaluate(`${HANDLE}.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
    assert.equal(await page.evaluate(`localStorage.getItem("${storeKey}")`), null);
    assert.equal(await width(page), start);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
});
