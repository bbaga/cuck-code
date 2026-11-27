"use strict";
// Real-browser check of the visual editor on /pipelines: palette, drop, text round trip,
// arrows, delete, save, broken YAML, read-only pipeline, 375 px. Skipped when no Chrome is available.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-canvas-home-"));
process.env.DUCK_HOME = home;
const dashboard = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");
const checks = require("./fixtures/choreo-graph-checks");

const ERRS = "window.__errs = [];"
  + "window.addEventListener('error', (e) => window.__errs.push(String(e.message)));"
  + "window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));"
  + "const __ce = console.error; console.error = (...a) => { window.__errs.push(a.join(' ')); __ce.apply(console, a); };";

test("visual editor: palette drop, text round trip, arrows, delete, save, broken YAML, read-only, 375 px", async (t) => {
  const fx = await dashboard.startDashboardFixture();
  const managedFile = path.join(process.env.LINES_DIR, "plugins", "pipelines", "visual-copy.yaml");
  let page = null;
  try {
    try { page = await openPage(fx.url + "/pipelines", { initScript: ERRS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    const q = (sel) => JSON.stringify(sel);
    const count = (sel) => page.evaluate(`document.querySelectorAll(${q(sel)}).length`);
    const click = (sel) => page.evaluate(`document.querySelector(${q(sel)}).click()`);
    const setText = (value) => page.evaluate(`(() => { const ta = document.getElementById('editor');
      ta.value = ${JSON.stringify(value)}; ta.dispatchEvent(new Event('input')); })()`);
    await page.setViewport(1280, 1000);

    // Duplicate "minimal" to a managed pipeline and open it.
    await page.waitFor("!!document.querySelector('button[data-name=minimal]')");
    const status = await page.evaluate(`fetch('/api/pipelines/minimal/duplicate', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newName: 'visual-copy' }) }).then((r) => r.status)`);
    assert.equal(status, 201);
    await page.evaluate("location.reload()");
    await page.waitFor("!!document.querySelector('button[data-name=visual-copy]')");
    await click("button[data-name=visual-copy]");
    await page.waitFor("document.getElementById('editor') && /name: visual-copy/.test(document.getElementById('editor').value)");

    // The tabs: roles, and the arrow keys move between them.
    assert.equal(await page.evaluate("document.querySelector('[role=tablist]').getAttribute('aria-label')"), "Editor mode");
    assert.deepEqual(await page.evaluate("[...document.querySelectorAll('[role=tab]')].map((x) => x.textContent)"), ["Text", "Visual"]);
    await page.evaluate("document.getElementById('tabText').focus()");
    await page.press("ArrowRight");
    await page.waitFor("document.getElementById('tabVisual').getAttribute('aria-selected') === 'true' && document.querySelectorAll('.cvNode').length === 4");
    assert.equal(await page.evaluate("document.getElementById('panelVisual').hidden"), false);
    assert.equal(await page.evaluate("document.getElementById('panelText').hidden"), true);
    assert.equal(await page.evaluate("localStorage.getItem('duck.pipelinesEditorMode')"), "visual");
    assert.ok(await page.evaluate("!!document.getElementById('inspectorHost')"));
    assert.equal(await count(".cvArrow"), 8);
    assert.equal(await count("[data-from=planner][data-to=impl]"), 3, "one arrow for each interaction");
    assert.deepEqual(await page.evaluate("[...document.querySelectorAll('[data-from=planner][data-to=impl] text')].map((x) => x.textContent)"),
      ["start", "feedback", "accept"]);
    assert.equal(await page.evaluate("document.querySelector('.cvPalette h2').textContent"), "Node types");
    assert.equal(await page.evaluate("[...document.querySelectorAll('.cvPalette h3')].pop().textContent"), "Base types");

    // Drag a backend-implementor from the palette to the canvas.
    await page.evaluate(`(() => {
      const item = document.querySelector('.cvPalItem[data-type=backend-implementor]');
      const dt = new DataTransfer();
      item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const box = document.querySelector('.cvBox').getBoundingClientRect();
      document.querySelector('.cvBox').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt,
        clientX: box.left + 500, clientY: box.top + 200 }));
    })()`);
    await page.waitFor("document.querySelector('.cvNode[data-node=backend-implementor]')");
    assert.equal(await count(".cvNode[data-node=backend-implementor] circle[data-anchor]"), 4);
    assert.deepEqual(await page.evaluate("[...document.querySelectorAll('.cvNode[data-node=backend-implementor] circle')].map((c) => c.getAttribute('data-anchor') + c.getAttribute('r'))"),
      ["top6", "right6", "bottom6", "left6"]);

    // Move a node with the real mouse. A drag from an anchor does not move it.
    const rectOf = (sel) => page.evaluate(`(() => { const r = document.querySelector(${q(sel)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const before = await rectOf(".cvNode[data-node=impl] rect");
    const anchor = await rectOf(".cvNode[data-node=impl] circle[data-anchor=top]");
    await page.mouse("mouseMoved", anchor.x + anchor.w / 2, anchor.y + anchor.h / 2);
    await page.mouse("mousePressed", anchor.x + anchor.w / 2, anchor.y + anchor.h / 2);
    await page.mouse("mouseMoved", anchor.x + 80, anchor.y + 60);
    await page.mouse("mouseReleased", anchor.x + 80, anchor.y + 60);
    assert.equal((await rectOf(".cvNode[data-node=impl] rect")).x, before.x, "an anchor does not move the node");
    const grab = { x: before.x + 20, y: before.y + before.h / 2 };
    await page.mouse("mouseMoved", grab.x, grab.y);
    await page.mouse("mousePressed", grab.x, grab.y);
    await page.mouse("mouseMoved", grab.x + 30, grab.y + 20);
    await page.mouse("mouseMoved", grab.x + 60, grab.y + 40);
    await page.mouse("mouseReleased", grab.x + 60, grab.y + 40);
    const after = await rectOf(".cvNode[data-node=impl] rect");
    assert.ok(Math.abs(after.x - before.x - 60) <= 1 && Math.abs(after.y - before.y - 40) <= 1, JSON.stringify([before, after]));
    const stored = JSON.parse(await page.evaluate("localStorage.getItem('duck.pipelineCanvas.visual-copy')"));
    assert.ok(stored.nodes.impl && stored.nodes["backend-implementor"]);

    // Text has the new node.
    await click("#tabText");
    await page.waitFor("document.getElementById('panelText').hidden === false");
    await page.waitFor("/backend-implementor:/.test(document.getElementById('editor').value)");
    assert.match(await page.evaluate("document.getElementById('editor').value"), /^# The order of the nodes/m, "comments stay");

    // An edit in the text shows on the canvas.
    await setText((await page.evaluate("document.getElementById('editor').value")).replace("type: backend-validator", "type: validator"));
    await click("#tabVisual");
    await page.waitFor("document.querySelector('.cvNode[data-node=val] .pgNodeType') && document.querySelector('.cvNode[data-node=val] .pgNodeType').textContent === 'validator'");

    // The new node has no edge: rule R2 shows in the Visual tab. Delete the node.
    await page.waitFor("[...document.querySelectorAll('#errors li')].some((l) => /^R2:/.test(l.textContent))");
    await page.evaluate("document.querySelector('.cvNode[data-node=backend-implementor] rect').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))");
    await page.press("Delete");
    await page.waitFor("!document.querySelector('.cvNode[data-node=backend-implementor]') && document.querySelectorAll('#errors li').length === 0");

    // Select one arrow and delete it: only that interaction leaves the YAML.
    await page.evaluate("document.querySelector('[data-arrow=\"planner->impl:feedback\"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))");
    assert.equal(await page.evaluate("document.querySelector('[data-arrow=\"planner->impl:feedback\"]').classList.contains('sel')"), true);
    await page.press("Delete");
    // Save is enabled when the text is written and valid.
    await page.waitFor("document.querySelectorAll('.cvArrow').length === 7 && !document.getElementById('saveBtn').disabled");
    await click("#tabText");
    const yaml = await page.evaluate("document.getElementById('editor').value");
    assert.match(yaml, /planner -> impl: start, accept/);
    assert.doesNotMatch(yaml, /feedback/);

    // Save works.
    await click("#saveBtn");
    await page.waitFor("/Saved 'visual-copy'/.test(document.getElementById('status').textContent)");
    assert.match(fs.readFileSync(managedFile, "utf8"), /backend-implementor/);

    // Broken YAML: the switch is refused and the error shows.
    await setText("name: [");
    await click("#tabVisual");
    await page.waitFor("/Fix the YAML first/.test(document.getElementById('status').textContent) && document.querySelectorAll('#errors li').length > 0");
    assert.equal(await page.evaluate("document.getElementById('tabText').getAttribute('aria-selected')"), "true");
    assert.equal(await page.evaluate("document.getElementById('panelVisual').hidden"), true);

    // A built-in pipeline shows the Visual tab with no palette. The tab stays selected in the next pipeline.
    await click("button[data-name=default]");
    await page.waitFor("document.getElementById('tabVisual') && document.getElementById('source')");
    await click("#tabVisual");
    await page.waitFor("document.querySelectorAll('.cvNode').length === 6 && !document.getElementById('panelVisual').hidden");
    assert.equal(await page.evaluate("document.getElementById('paletteHost').hidden"), true);
    assert.equal(await count(".cvPalItem"), 0);
    assert.ok(await count(".cvArrow") > 6);
    await page.press("Delete");
    assert.equal(await count(".cvNode"), 6, "no delete in a read-only pipeline");

    // 375 px: no horizontal page scroll.
    await page.setViewport(375, 900);
    assert.ok(await page.evaluate("document.documentElement.scrollWidth <= 376"), "no horizontal scroll at 375 px");
    assert.ok(await page.evaluate("document.querySelector('.cvBox').getBoundingClientRect().right <= 376"));
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await checks.removeManaged(fx.url, ["visual-copy"]);
    await fx.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("visual editor: connect nodes with arrows and choose the interaction type", async (t) => {
  const fx = await dashboard.startDashboardFixture();
  let page = null;
  try {
    try { page = await openPage(fx.url + "/pipelines", { initScript: ERRS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    const q = (sel) => JSON.stringify(sel);
    const click = (sel) => page.evaluate(`document.querySelector(${q(sel)}).click()`);
    const count = (sel) => page.evaluate(`document.querySelectorAll(${q(sel)}).length`);
    const center = (sel) => page.evaluate(`(() => { const r = document.querySelector(${q(sel)}).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const editorText = async () => { await click("#tabText"); await page.waitFor("!document.getElementById('panelText').hidden");
      const v = await page.evaluate("document.getElementById('editor').value"); await click("#tabVisual");
      await page.waitFor("!document.getElementById('panelVisual').hidden && document.querySelectorAll('.cvNode').length > 0"); return v; };
    const drag = async (from, to, drop = true) => {
      const a = await center(from), b = await center(to);
      await page.mouse("mouseMoved", a.x, a.y);
      await page.mouse("mousePressed", a.x, a.y);
      await page.mouse("mouseMoved", (a.x + b.x) / 2, (a.y + b.y) / 2);
      await page.mouse("mouseMoved", b.x, b.y);
      if (drop) await page.mouse("mouseReleased", b.x, b.y);
    };
    const choices = () => page.evaluate("[...document.querySelectorAll('.cvDialog input')].map((i) => i.value + (i.disabled ? ':disabled' : '') + (i.checked ? ':checked' : ''))");
    const check = (name) => page.evaluate(`(() => { const i = document.querySelector('.cvDialog input[value=${name}]'); i.click(); })()`);
    const dialogGone = () => page.waitFor("!document.querySelector('.cvDialog')");
    await page.setViewport(1280, 1000);
    await page.waitFor("!!document.querySelector('button[data-name=minimal]')");
    await page.evaluate(`fetch('/api/pipelines/minimal/duplicate', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newName: 'connect-copy' }) })`);
    await page.evaluate("location.reload()");
    await page.waitFor("!!document.querySelector('button[data-name=connect-copy]')");
    await click("button[data-name=connect-copy]");
    await page.waitFor("document.getElementById('editor') && /name: connect-copy/.test(document.getElementById('editor').value)");
    await click("#tabVisual");
    await page.waitFor("document.querySelectorAll('.cvNode').length === 4");
    await page.evaluate(`(() => {
      const dt = new DataTransfer();
      document.querySelector('.cvPalItem[data-type=backend-implementor]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const box = document.querySelector('.cvBox').getBoundingClientRect();
      document.querySelector('.cvBox').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: box.left + 500, clientY: box.top + 250 }));
    })()`);
    await page.waitFor("!!document.querySelector('.cvNode[data-node=backend-implementor]')");
    const impl = "backend-implementor";
    const anchorOf = (node, side) => `.cvNode[data-node=${node}] circle[data-anchor=${side}]`;
    assert.equal(await page.evaluate("document.querySelectorAll('.cvAnchor[tabindex]').length"), 0, "anchors are no tab stops");

    // Planner -> new node: start, feedback, accept are valid; report is not.
    await drag(anchorOf("planner", "right"), anchorOf(impl, "left"));
    await page.waitFor("!!document.querySelector('.cvDialog[open] input')");
    assert.equal(await page.evaluate("document.querySelector('.cvDialog h2').textContent"), "What type of interaction does this arrow represent?");
    assert.deepEqual(await choices(), ["accept", "feedback", "start"]);
    assert.equal(await page.evaluate("document.querySelector('.cvOk').disabled"), true);
    await check("start");
    assert.equal(await page.evaluate("document.querySelector('.cvOk').disabled"), false);
    await click(".cvOk");
    await dialogGone();
    assert.match(await editorText(), new RegExp("planner -> " + impl + ": start"));
    assert.equal(await count(".cvTemp"), 0, "the temporary arrow is gone");

    // New node -> planner: report.
    await drag(anchorOf(impl, "left"), anchorOf("planner", "right"));
    await page.waitFor("!!document.querySelector('.cvDialog[open] input')");
    assert.ok((await choices()).includes("report"));
    await check("report");
    await click(".cvOk");
    await dialogGone();
    await page.waitFor(`!!document.querySelector('[data-arrow="${impl}->planner:report"]')`);

    // Cancel changes nothing.
    const textBefore = await editorText();
    await drag(anchorOf("planner", "right"), anchorOf(impl, "left"));
    await page.waitFor("!!document.querySelector('.cvDialog[open]')");
    await click(".cvCancel");
    await dialogGone();
    assert.equal(await editorText(), textBefore);
    assert.equal(await count(".cvTemp"), 0);

    // A drop in an empty place cancels, and the dashed arrow shows during the drag.
    const a = await center(anchorOf("planner", "top"));
    await page.mouse("mouseMoved", a.x, a.y);
    await page.mouse("mousePressed", a.x, a.y);
    await page.mouse("mouseMoved", a.x + 40, a.y - 5);
    assert.equal(await count(".cvTemp"), 1);
    await page.mouse("mouseReleased", a.x + 40, a.y - 5);
    assert.equal(await count(".cvTemp"), 0);

    // The same anchor pair again: start is already there; add feedback.
    await drag(anchorOf("planner", "right"), anchorOf(impl, "left"));
    await page.waitFor("!!document.querySelector('.cvDialog[open] input')");
    assert.ok((await choices()).includes("start:disabled:checked"), JSON.stringify(await choices()));
    assert.match(await page.evaluate("document.querySelector('.cvDialog').textContent"), /already on this arrow/);
    await check("feedback");
    await click(".cvOk");
    await dialogGone();
    await page.waitFor(`!!document.querySelector('[data-arrow="planner->${impl}:feedback"]')`);
    for (const key of [`planner->${impl}:start`, `planner->${impl}:feedback`, `${impl}->planner:report`]) {
      await page.evaluate(`document.querySelector('[data-arrow="${key}"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
      assert.equal(await page.evaluate(`[...document.querySelectorAll('.cvArrow.sel')].map((g) => g.dataset.arrow).join()`), key);
    }
    assert.match(await editorText(), new RegExp("planner -> " + impl + ": start, feedback"));

    // Delete only feedback.
    await page.evaluate(`document.querySelector('[data-arrow="planner->${impl}:feedback"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await page.press("Delete");
    await page.waitFor(`!document.querySelector('[data-arrow="planner->${impl}:feedback"]') && !!document.querySelector('[data-arrow="planner->${impl}:start"]')`);

    // Double-click start, uncheck it: the edge is gone.
    await page.evaluate(`document.querySelector('[data-arrow="planner->${impl}:start"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await page.waitFor("!!document.querySelector('.cvDialog[open] input')");
    assert.ok((await choices()).includes("start:checked"));
    await check("start");
    await click(".cvOk");
    await dialogGone();
    await page.waitFor(`!document.querySelector('[data-from=planner][data-to=${impl}]')`);
    assert.doesNotMatch(await editorText(), new RegExp("planner -> " + impl));

    // The keyboard path: select a node, "c", arrow keys, Enter.
    await page.evaluate(`document.querySelector('.cvNode[data-node=planner] rect').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))`);
    await page.press("c");
    assert.equal(await count(".cvNode.target"), 1);
    await page.press("ArrowRight");
    await page.press("Enter");
    await page.waitFor("!!document.querySelector('.cvDialog[open] input')");
    await page.press("Escape");
    await dialogGone();
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await checks.removeManaged(fx.url, ["connect-copy"]);
    await fx.close();
  }
});
