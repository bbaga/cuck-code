"use strict";
// Real-browser check of the pipelines page (D6): lists, read-only view, duplicate, edit with an
// error, fix, save, delete, 375 px. Skipped when no Chrome is available.
// Set PIPELINES_PAGE_SHOTS=<dir> to save screenshots.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// No pipelines of the real home folder in this test.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pipelines-page-home-"));
process.env.CUCK_HOME = home;
const dashboard = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");
const choreo = require("./choreo-fixtures");
const checks = require("./fixtures/choreo-graph-checks");

// server.js keeps the LINES_DIR of the first fixture of the process. Later fixtures change
// process.env.LINES_DIR, but the server does not follow. Remember the folder of the first one.
let serverLinesDir = null;
async function startDashboardFixture() {
  const fx = await dashboard.startDashboardFixture();
  if (!serverLinesDir) serverLinesDir = process.env.LINES_DIR;
  return fx;
}

const ERRS = "window.__errs = [];"
  + "window.addEventListener('error', (e) => window.__errs.push(String(e.message)));"
  + "window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));"
  + "document.addEventListener('securitypolicyviolation', (e) => window.__errs.push('CSP ' + e.violatedDirective));"
  + "const __ce = console.error; console.error = (...a) => { window.__errs.push(a.join(' ')); __ce.apply(console, a); };";

test("pipelines page: lists, read-only view, duplicate, edit with error, fix, save, delete, 375 px", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    try { page = await openPage(fx.url + "/pipelines", { initScript: ERRS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    const shots = process.env.PIPELINES_PAGE_SHOTS;
    if (shots) fs.mkdirSync(shots, { recursive: true });
    const shot = async (name) => { if (shots) await page.screenshot(path.join(shots, name)); };
    const click = (sel) => page.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
    const text = (sel) => page.evaluate(`document.querySelector(${JSON.stringify(sel)}).textContent`);
    const managedFile = path.join(serverLinesDir, "plugins", "pipelines", "my-copy.yaml");
    await page.setViewport(1100, 1000);

    // the three groups
    await page.waitFor("document.querySelectorAll('#listHost button.item').length > 5");
    assert.deepEqual(await page.evaluate("[...document.querySelectorAll('#listHost h2')].map((h) => h.textContent.replace(/ \\(\\d+\\)/, ''))"),
      ["Pipelines", "Node types", "Interactions"]);
    assert.ok(await page.evaluate("!!document.querySelector('[data-group=pipelines] button[data-name=default]')"));
    assert.ok(await page.evaluate("!!document.querySelector('[data-group=nodeTypes] button[data-name=planner]')"));
    assert.ok(await page.evaluate("!!document.querySelector('[data-group=interactions] button[data-name=report]')"));
    assert.match(await text("button[data-name=default]"), /built-in/);
    assert.equal(await page.evaluate("document.querySelector('a#backLink').getAttribute('href')"), "/");

    // a node type is read-only text without a duplicate button
    await click("[data-group=nodeTypes] button[data-name=planner]");
    await page.waitFor("document.getElementById('source') && /planner/.test(document.getElementById('source').textContent)");
    assert.equal(await page.evaluate("document.getElementById('dupBtn')"), null);

    // a built-in pipeline: read-only, no editor, a Duplicate button, a graph
    await click("button[data-name=default]");
    await page.waitFor("document.getElementById('source') && /start: planner/.test(document.getElementById('source').textContent)"
      + " && document.querySelector('#graphBox svg')");
    assert.equal(await page.evaluate("document.getElementById('editor')"), null);
    assert.equal(await text("#dupBtn"), "Duplicate to edit");
    assert.equal(await page.evaluate("document.getElementById('saveBtn')"), null);
    assert.equal(await page.evaluate("document.querySelectorAll('#graphBox .pgNode').length"), 6);
    await shot("pipelines-readonly-1100.png");

    // duplicate it to my-copy
    await click("#dupBtn");
    await page.waitFor("document.getElementById('nameInput')");
    await page.evaluate("(() => { const i = document.getElementById('nameInput'); i.value = 'Bad Name'; document.querySelector('.nameForm button[type=submit]').click(); })()");
    await page.waitFor("/name has/i.test(document.querySelector('.nameForm .err').textContent)");
    await page.evaluate("(() => { const i = document.getElementById('nameInput'); i.value = 'my-copy'; document.querySelector('.nameForm button[type=submit]').click(); })()");
    await page.waitFor("document.getElementById('editor') && document.querySelector('#graphBox svg')");
    assert.match(await page.evaluate("document.getElementById('editor').value"), /name: my-copy/);
    assert.equal(await page.evaluate("document.getElementById('editor').getAttribute('spellcheck')"), "false");
    assert.equal(await page.evaluate("document.getElementById('saveBtn').disabled"), true, "nothing changed yet");
    assert.ok(fs.existsSync(managedFile));
    assert.equal(await page.evaluate("document.querySelectorAll('#graphBox .pgNode').length"), 6);
    assert.match(await text("[data-group=pipelines] button[data-name=my-copy]"), /managed/);

    // an edit that breaks the pipeline: an error shows and Save stays disabled
    const edit = (from, to) => page.evaluate(`(() => { const ta = document.getElementById('editor');
      ta.value = ta.value.replace(${JSON.stringify(from)}, ${JSON.stringify(to)}); ta.dispatchEvent(new Event('input')); })()`);
    await edit("start: planner", "start: nowhere");
    assert.equal(await page.evaluate("document.getElementById('saveBtn').disabled"), true, "disabled while checking");
    await page.waitFor("document.querySelectorAll('#errors li').length > 0");
    const errs = await page.evaluate("[...document.querySelectorAll('#errors li')].map((l) => l.textContent)");
    assert.ok(errs.every((e) => /^\w+: .+/.test(e)), JSON.stringify(errs));
    assert.equal(await page.evaluate("document.getElementById('errors').getAttribute('role')"), "alert");
    assert.equal(await page.evaluate("document.getElementById('saveBtn').disabled"), true);
    assert.equal(await page.evaluate("document.querySelectorAll('#graphBox .pgNode').length"), 6, "last good graph stays");
    await shot("pipelines-editor-error-1100.png");

    // fix it and save
    await edit("start: nowhere", "start: planner");
    await page.waitFor("document.querySelectorAll('#errors li').length === 0 && !/Checking/.test(document.getElementById('saveWhy').textContent)");
    await edit("description:", "description: edited;");
    await page.waitFor("!document.getElementById('saveBtn').disabled");
    await shot("pipelines-editor-fixed-1100.png");
    await click("#saveBtn");
    await page.waitFor("/Saved 'my-copy'/.test(document.getElementById('status').textContent)");
    assert.equal(await page.evaluate("document.getElementById('saveBtn').disabled"), true, "saved: nothing changed");
    assert.match(fs.readFileSync(managedFile, "utf8"), /edited;/);

    // reload: the list shows the file in the managed layer
    // The marker lives only in the old document, so waiting for it to vanish waits for the new one.
    await page.evaluate("window.__beforeReload = 1");
    await page.evaluate("location.reload()");
    await page.waitFor("!window.__beforeReload && document.readyState === 'complete'");
    await page.waitFor("(() => { const b = document.querySelector('[data-group=pipelines] button[data-name=my-copy]'); return !!b && /managed/.test(b.textContent); })()");
    await click("[data-group=pipelines] button[data-name=my-copy]");
    await page.waitFor("document.getElementById('editor') && /edited;/.test(document.getElementById('editor').value)");

    // delete asks first
    await click("#delBtn");
    await page.waitFor("document.getElementById('delYes')");
    await click("#delNo");
    assert.equal(await page.evaluate("document.getElementById('delYes')"), null);
    assert.ok(fs.existsSync(managedFile));
    await click("#delBtn");
    await click("#delYes");
    await page.waitFor("!document.querySelector('[data-group=pipelines] button[data-name=my-copy]')");
    assert.equal(fs.existsSync(managedFile), false);

    // new pipeline: a copy of minimal
    await click("#newBtn");
    await page.evaluate("(() => { document.getElementById('nameInput').value = 'fresh'; document.querySelector('.nameForm button[type=submit]').click(); })()");
    await page.waitFor("document.getElementById('editor') && /name: fresh/.test(document.getElementById('editor').value)");
    await click("#delBtn");
    await click("#delYes");
    await page.waitFor("!document.querySelector('button[data-name=fresh]')");

    // 375 px: columns stack, no horizontal page scroll
    await click("button[data-name=default]");
    await page.waitFor("document.querySelector('#graphBox svg')");
    await page.setViewport(375, 900);
    await shot("pipelines-375.png");
    assert.ok(await page.evaluate("document.documentElement.scrollWidth <= 376"), "no horizontal scroll at 375 px");
    assert.ok(await page.evaluate("document.body.scrollWidth <= 376"));
    assert.ok(await page.evaluate("document.getElementById('detailCol').getBoundingClientRect().top >= document.getElementById('listCol').getBoundingClientRect().bottom - 1"), "columns stack");

    assert.deepEqual(await page.evaluate("window.__errs"), []);

    // the dashboard links here (its CDN scripts are not reachable in the test, so no error check there)
    await page.evaluate("location.href = '/'");
    await page.waitFor("document.getElementById('pipelinesBtn')");
  } finally {
    if (page) await page.close();
    await checks.removeManaged(fx.url, ["my-copy", "fresh"]);
    await fx.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Opens /pipelines with pipelines 1 and 2 stored as managed pipelines. `initScript` adds to ERRS.
async function openChoreoPage(t, fx, initScript = "") {
  let page;
  try { page = await openPage(fx.url + "/pipelines", { initScript: ERRS + initScript }); }
  catch (e) {
    if (e.code === "BROWSER_UNAVAILABLE") { t.skip("Chrome is missing: " + e.message); return null; }
    throw e;
  }
  await page.waitFor("!!document.querySelector('button[data-name=minimal]')");
  for (const [name, text] of [["choreo-chain", choreo.CHAIN], ["choreo-stage", choreo.STAGE]]) {
    const body = JSON.stringify({ text: text.replace("name: choreographed", "name: " + name) });
    const status = await page.evaluate(`fetch('/api/pipelines/${name}', { method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(body)} }).then((r) => r.status)`);
    assert.ok(status === 200 || status === 201, name + ": " + status);
  }
  await page.evaluate("location.reload()");
  await page.waitFor("!!document.querySelector('button[data-name=choreo-stage]')");
  return page;
}

async function openItem(page, name, nodes) {
  await page.evaluate(`document.querySelector('button[data-name=${name}]').click()`);
  await page.waitFor(`/name: ${name}/.test((document.getElementById('editor') || document.getElementById('source')).value
    || document.getElementById('source').textContent) && document.querySelectorAll('#graphBox .pgNode').length === ${nodes}`);
}

const cleanManaged = (fx) => checks.removeManaged(fx.url, ["choreo-chain", "choreo-stage"]);

test("pipelines page: pipelines 1 and 2 show wait badge, edge styles, fan-out and fit at 1280 px and 320 px", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    page = await openChoreoPage(t, fx);
    if (!page) return;
    const shots = process.env.PIPELINES_PAGE_SHOTS;
    if (shots) fs.mkdirSync(shots, { recursive: true });
    const shot = async (name) => { if (shots) await page.screenshot(path.join(shots, name)); };
    const count = (sel) => page.evaluate(`document.querySelectorAll(${JSON.stringify("#graphBox " + sel)}).length`);
    await page.setViewport(1280, 1000);

    await openItem(page, "choreo-chain", 5);
    assert.equal(await page.evaluate("document.querySelector('#graphBox .pgNode.wait .node-badge-wait').textContent"), "wait");
    assert.equal(await count("path.pgEdge.edge-handoff"), 2);
    assert.equal(await count("path.pgEdge.edge-rework"), 1);
    assert.equal(await count("path.pgEdge.edge-arrive"), 1);
    await checks.checkEdgeStyles(page, "#graphBox");
    assert.deepEqual(await page.evaluate("[...document.querySelectorAll('#edgesList li')].map((l) => l.textContent)"), checks.CHAIN_EDGE_LINES);
    await checks.checkFit(page, "#graphBox", 1280);
    await shot("chain-1280-before-scroll.png");
    await checks.scrollRight(page, "#graphBox");
    await shot("chain-1280-after-scroll.png");

    await page.setViewport(320, 900);
    await page.evaluate("document.getElementById('graphBox').scrollIntoView()");
    await checks.checkFit(page, "#graphBox", 320);
    assert.ok(await page.evaluate("document.getElementById('graphBox').getBoundingClientRect().right <= 320"));
    await shot("chain-320-before-scroll.png");
    await checks.scrollRight(page, "#graphBox");
    await shot("chain-320-after-scroll.png");
    await page.setViewport(1280, 1000);

    await openItem(page, "choreo-stage", 6);
    assert.equal(await count("path.pgEdge.edge-handoff"), 3);
    assert.equal(await count("path.pgEdge.edge-rework"), 2);
    assert.equal(await count("path.pgEdge.edge-arrive"), 2);
    await checks.checkEdgeStyles(page, "#graphBox");
    await checks.checkStage(page, "#graphBox");
    await checks.checkFit(page, "#graphBox", 1280);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await cleanManaged(fx);
    await fx.close();
  }
});

test("pipelines page: default and minimal show edges in several columns; optional nodes draw", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    page = await openChoreoPage(t, fx);
    if (!page) return;
    await page.setViewport(1280, 1000);
    const columns = [["default", 6, 14], ["minimal", 4, 8], ["planner-only", 1, 0], ["implement-only", 2, 2]];
    for (const [name, nodes, edges] of columns) {
      await openItem(page, name, nodes);
      await page.waitFor(`document.querySelectorAll('#graphBox path.pgEdge').length === ${edges}`);
      assert.equal(await page.evaluate("document.querySelectorAll('#graphBox .hint').length"), 0, name);
      assert.equal(await page.evaluate("document.querySelectorAll('#edgesList li').length > 0"), edges > 0, name);
      const xs = await page.evaluate("new Set([...document.querySelectorAll('#graphBox .pgNode rect')].map((r) => r.getAttribute('x'))).size");
      assert.equal(xs > 1, nodes > 1, name + ": " + xs + " x positions");
      if (nodes > 2) assert.ok(xs >= 3, name);
    }
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await cleanManaged(fx);
    await fx.close();
  }
});

// The driver has no page.route: a flag in the page makes its fetch answer 500 for the validate call.
const FAIL_VALIDATE = "window.__failValidate = true; const __vf = window.fetch; window.fetch = (url, opts) =>"
  + " (window.__failValidate && opts && opts.method === 'POST' && /\\/api\\/pipelines\\/validate$/.test(String(url))"
  + "   ? Promise.resolve(new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'Content-Type': 'application/json' } }))"
  + "   : __vf.call(window, url, opts));";

test("pipelines page: a failing validate call leaves a nodes-only graph and no page error", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    page = await openChoreoPage(t, fx, FAIL_VALIDATE);
    if (!page) return;
    await page.setViewport(1280, 1000);
    await openItem(page, "default", 6);
    assert.equal(await page.evaluate("window.__failValidate"), true);
    assert.equal(await page.evaluate("document.querySelectorAll('#graphBox path.pgEdge').length"), 0);
    assert.equal(await page.evaluate("document.querySelectorAll('#graphBox svg').length"), 1);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await cleanManaged(fx);
    await fx.close();
  }
});
