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
const { startDashboardFixture } = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");
const choreo = require("./choreo-fixtures");

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
    const managedFile = path.join(process.env.LINES_DIR, "plugins", "pipelines", "my-copy.yaml");
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
    await fx.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("pipelines page: choreographed pipeline, optional nodes, 1280 px and 320 px", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  let created = false;
  try {
    try { page = await openPage(fx.url + "/pipelines", { initScript: ERRS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    const shots = process.env.PIPELINES_PAGE_SHOTS;
    if (shots) fs.mkdirSync(shots, { recursive: true });
    const shot = async (name) => { if (shots) await page.screenshot(path.join(shots, name)); };
    const count = (sel) => page.evaluate(`document.querySelectorAll(${JSON.stringify("#graphBox " + sel)}).length`);
    const open = async (name) => {
      await page.evaluate(`document.querySelector('button[data-name=${name}]').click()`);
      await page.waitFor(`document.querySelector('#graphBox svg') && new RegExp('name: ${name}').test(document.getElementById('editor') ? document.getElementById('editor').value : document.getElementById('source').textContent)`);
    };
    await page.setViewport(1280, 1000);
    // store pipeline 1 as a managed pipeline
    const chain = JSON.stringify(choreo.CHAIN.replace("name: choreographed", "name: choreo-chain"));
    await page.waitFor("!!document.querySelector('button[data-name=minimal]')");
    created = true;
    const status = await page.evaluate(`fetch('/api/pipelines/choreo-chain', { method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: ${chain} }) }).then((r) => r.status)`);
    assert.equal(status, 201);
    await page.evaluate("location.reload()");
    await page.waitFor("!!document.querySelector('button[data-name=choreo-chain]')");
    await open("choreo-chain");
    assert.equal(await count(".pgNode.wait .node-badge-wait"), 1);
    assert.equal(await page.evaluate("document.querySelector('#graphBox .node-badge-wait').textContent"), "wait");
    assert.equal(await count("path.pgEdge.edge-handoff"), 2);
    assert.equal(await count("path.pgEdge.edge-rework"), 1);
    assert.equal(await count("path.pgEdge.edge-arrive"), 1);
    const labels = await page.evaluate("[...document.querySelectorAll('#graphBox .pgEdgeLabel')].map((l) => l.textContent)");
    assert.ok(labels.includes("rework (FAIL)") && labels.includes("arrive (PASS)"), labels.join("|"));
    // the text list keeps its format
    assert.ok((await page.evaluate("[...document.querySelectorAll('#edgesList li')].map((l) => l.textContent)")).includes("val -> impl: rework"));
    assert.ok(await page.evaluate("document.documentElement.scrollWidth <= 1281"));
    await shot("pipelines-choreo-1280.png");

    await page.setViewport(320, 900);
    await page.evaluate("document.getElementById('graphBox').scrollIntoView()");
    await shot("pipelines-choreo-320.png");
    assert.ok(await page.evaluate("document.documentElement.scrollWidth <= 321"), "no horizontal page scroll at 320 px");
    const box = "document.getElementById('graphBox')";
    assert.ok(await page.evaluate(`${box}.getBoundingClientRect().right <= 320`), "graph box inside the viewport");
    await page.setViewport(1280, 1000);

    // optional nodes: planner-only has one node and no edge, implement-only two nodes
    for (const [name, nodes, edges] of [["planner-only", 1, 0], ["implement-only", 2, 2]]) {
      await open(name);
      await page.waitFor(`document.querySelectorAll('#graphBox .pgNode').length === ${nodes} && document.querySelectorAll('#graphBox path.pgEdge').length === ${edges}`);
      assert.equal(await count(".pgNode"), nodes, name);
      assert.equal(await count("path.pgEdge"), edges, name);
      assert.equal(await count(".hint"), 0, name);
      assert.equal(await page.evaluate("document.querySelectorAll('#edgesList li').length"), edges, name);
    }
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await fx.close();
    if (created) fs.rmSync(path.join(process.env.LINES_DIR, "plugins", "pipelines", "choreo-chain.yaml"), { force: true });
  }
});
