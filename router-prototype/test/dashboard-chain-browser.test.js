"use strict";
// Real-browser check of the chain parts of the dashboard: the wait card, the rework counter,
// the stage chips, the wait lane column and the default line. Skipped when no Chrome is available.
// Set DASHBOARD_CHAIN_SHOTS=<dir> to save screenshots.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startDashboardFixture } = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");
const choreo = require("./choreo-fixtures");

const STUBS = "window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };"
  + "window.marked = { use() {}, parse: (t) => String(t) };"
  + "window.__errs = [];"
  + "window.addEventListener('error', (e) => window.__errs.push(String(e.message)));"
  + "const __ce = console.error; console.error = (...a) => { window.__errs.push(a.join(' ')); __ce.apply(console, a); };";

const head = (id, extra = {}) => ({ id, name: id, role: "implementor", node: "impl", persona: "backend", status: "completed",
  repo: "api", branch: "b/" + id, runGeneration: 1, transcript: [], children: [], ...extra });
const checker = (id, node, validates) => ({ id, name: id, role: "validator", kind: "standard", node, validates,
  status: "completed", verdict: "pass", transcript: [] });
const waiter = (id, members, extra = {}) => ({ id, name: id, role: "wait", kind: "wait", runner: "wait", node: "batch",
  members, arrivals: {}, status: "running", transcript: [], ...extra });

async function open(t, fx, graph, seed) {
  const line = require("../server").lines.get(fx.lineId);
  if (graph) line.graph = graph;
  seed(line);
  try { return await openPage(fx.url, { initScript: STUBS }); }
  catch (e) {
    if (e.code === "BROWSER_UNAVAILABLE") { t.skip("Chrome is missing: " + e.message); return null; }
    throw e;
  }
}

const q = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.textContent.trim())`;
const send = (event, data) => require("../server").broadcast(
  require("../server").lines.get("browser-line"), event, data);
const fit = async (page, width) => {
  assert.ok(await page.evaluate(`document.documentElement.scrollWidth <= ${width}`), "no sideways scroll at " + width);
  assert.deepEqual(await page.evaluate("window.__errs"), [], "no console error");
};

async function run(t, graph, seed, body) {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    page = await open(t, fx, graph, seed);
    if (!page) return;
    await page.setViewport(1280, 900);
    await page.waitFor("/browser[- ]line/i.test(document.body.innerText)");
    await body(page, async (name) => {
      const dir = process.env.DASHBOARD_CHAIN_SHOTS;
      if (dir) { fs.mkdirSync(dir, { recursive: true }); await page.screenshot(path.join(dir, name)); }
    });
  } finally {
    if (page) await page.close();
    await fx.close();
  }
}

test("wait card: members in order, wait_update, stale member, timeout outcome, lane column", async (t) => {
  const seed = (line) => {
    line.workers.set("a", head("a", { name: "alpha" }));
    line.workers.set("b", head("b", { name: "beta" }));
    line.workers.set("va", checker("va", "val", "a"));
    line.workers.set("vb", checker("vb", "val", "b"));
    line.workers.set("w", waiter("w", ["a", "b"], { name: "batch-1", arrivals: { a: { runGeneration: 1, checkerId: "va" } } }));
  };
  await run(t, choreo.resolve(choreo.CHAIN), seed, async (page, shot) => {
    await page.waitFor("document.querySelector('.waitCard')");
    assert.deepEqual(await page.evaluate(q(".waitCard li")), ["alpha: arrived", "beta: waiting"]);
    assert.deepEqual(await page.evaluate(q(".waitCard li.wait-member-arrived")), ["alpha: arrived"]);
    assert.deepEqual(await page.evaluate(q(".waitCard li.wait-member-waiting")), ["beta: waiting"]);
    assert.match((await page.evaluate(q(".waitCard .waitStatus")))[0], /status: running/);
    await shot("wait-card-1280.png");

    // The wait worker stands in its own column, after the validators, in the row of its members.
    const pos = await page.evaluate(`(() => { const p = {}; for (const n of document.querySelectorAll('.graph .gnode.worker'))
      p[n.querySelector('.nodeName').textContent] = [n.offsetLeft, n.offsetTop]; return p; })()`);
    assert.ok(pos["batch-1"][0] > pos["alpha"][0] && pos["batch-1"][0] > pos["va"][0], "after the validators: " + JSON.stringify(pos));
    assert.equal(pos["batch-1"][1], pos["alpha"][1], "in the row of the members");

    send("wait_update", { workerId: "w", members: [{ id: "a", name: "alpha", state: "arrived" }, { id: "b", name: "beta", state: "arrived" }] });
    await page.waitFor(`${q(".waitCard li.wait-member-arrived")}.length === 2`);
    send("wait_update", { workerId: "w", members: [{ id: "a", name: "alpha", state: "arrived" }, { id: "b", name: "beta", state: "stale" }] });
    await page.waitFor(`${q(".waitCard li.wait-member-stale")}[0] === 'beta: stale'`);
    send("worker_status", { workerId: "w", status: "stopped", verdict: null, outcome: "timeout", runner: "wait",
      members: [{ id: "a", name: "alpha", state: "arrived" }, { id: "b", name: "beta", state: "waiting" }] });
    await page.waitFor(`/outcome: timed out/.test(${q(".waitCard .waitStatus")}[0])`);
    assert.match((await page.evaluate(q(".waitCard .waitStatus")))[0], /status: stopped/);
    await fit(page, 1280);
    await page.setViewport(320, 900);
    await shot("wait-card-320.png");
    await fit(page, 320);
  });
});

test("line graph: member validators feed the wait worker, the wait worker feeds its integration", async (t) => {
  const seed = (line) => {
    for (const id of ["a", "b", "c"]) line.workers.set(id, head(id, { name: "impl-" + id }));
    for (const id of ["a", "b", "c"]) line.workers.set("v" + id, checker("v" + id, "val", id));
    line.workers.set("w", waiter("w", ["a", "b", "c"], { name: "batch-1", status: "completed", outcome: "pass" }));
    line.workers.set("g", { id: "g", name: "merge-1", role: "validator", kind: "integration", node: "integration",
      status: "running", transcript: [],
      integration: { repos: [{ branches: ["a", "b", "c"].map((workerId) => ({ workerId })) }] } });
  };
  await run(t, choreo.resolve(choreo.CHAIN), seed, async (page, shot) => {
    await page.waitFor("document.querySelectorAll('.graph .gnode.worker').length === 8");
    const relations = await page.evaluate(`[...document.querySelectorAll('.graph svg path[data-target]')]
      .map((p) => p.getAttribute('data-source') + '>' + p.getAttribute('data-target'))`);
    const into = (target) => relations.filter((r) => r.endsWith(">" + target)).sort();
    assert.deepEqual(into("w"), ["va>w", "vb>w", "vc>w"], "one relation per validator: " + relations);
    assert.deepEqual(into("g"), ["w>g"], "one relation from the wait worker: " + relations);
    assert.equal(relations.includes("planner>w"), false);
    assert.equal(relations.includes("planner>g"), false);
    await shot("wait-relations-1280.png");

    const pos = await page.evaluate(`(() => { const p = {}; for (const n of document.querySelectorAll('.graph .gnode.worker'))
      p[n.querySelector('.nodeName').textContent] = [n.offsetLeft, n.offsetTop]; return p; })()`);
    for (const v of ["va", "vb", "vc"]) assert.ok(pos["batch-1"][0] > pos[v][0], "after the validators: " + JSON.stringify(pos));
    assert.equal(pos["batch-1"][1], pos["impl-a"][1], "in the row of the first member");
    assert.deepEqual(await page.evaluate("window.__errs"), [], "no console error");
  });
});

test("wait card: a finished wait worker from the state shows its outcome after a load", async (t) => {
  const seed = (line) => {
    line.workers.set("a", head("a"));
    line.workers.set("w", waiter("w", ["a"], { status: "stopped", outcome: "timeout" }));
  };
  await run(t, choreo.resolve(choreo.CHAIN), seed, async (page) => {
    await page.waitFor("document.querySelector('.waitCard')");
    assert.match((await page.evaluate(q(".waitCard .waitStatus")))[0], /status: stopped.*outcome: timed out/);
  });
});

test("head card: rework counter and stage chips follow worker_status, chips go with the stage", async (t) => {
  const stage = { sender: "impl", members: { val: { status: "running", outcome: null, checkerId: "x" },
    lint: { status: "queued", outcome: null, checkerId: null } } };
  const seed = (line) => line.workers.set("h", head("h", { name: "head", reworkRounds: { impl: 1 },
    maxRounds: { impl: 3 }, stage }));
  await run(t, choreo.resolve(choreo.STAGE), seed, async (page, shot) => {
    await page.waitFor("document.querySelector('.headCard')");
    assert.deepEqual(await page.evaluate(q(".headCard .reworkCounter")), ["rework round 1 / 3"]);
    assert.deepEqual(await page.evaluate(q(".headCard li")), ["val: running", "lint: queued"]);
    assert.equal((await page.evaluate(q(".headCard li.stage-chip-running"))).length, 1);
    assert.equal((await page.evaluate(q(".headCard li.stage-chip-queued"))).length, 1);
    await shot("head-card-1280.png");

    send("worker_status", { workerId: "h", status: "completed", verdict: null, worker: { id: "h", reworkRounds: { impl: 2 },
      maxRounds: { impl: 3 }, stage: { sender: "impl", members: [{ node: "val", status: "done", outcome: "pass", checkerId: "x" },
        { node: "lint", status: "done", outcome: "reject", checkerId: "y" }] } } });
    await page.waitFor(`${q(".headCard li")}.join() === 'val: PASS,lint: FAIL'`);
    assert.equal((await page.evaluate(q(".headCard li.stage-chip-pass"))).length, 1);
    assert.equal((await page.evaluate(q(".headCard li.stage-chip-fail"))).length, 1);
    assert.deepEqual(await page.evaluate(q(".headCard .reworkCounter")), ["rework round 2 / 3"]);
    await page.setViewport(320, 900);
    await shot("head-card-320.png");
    await fit(page, 320);

    send("worker_status", { workerId: "h", status: "completed", verdict: null, worker: { id: "h", reworkRounds: { impl: 2 },
      maxRounds: { impl: 3 }, stage: null } });
    await page.waitFor(`${q(".headCard li")}.length === 0`);
    assert.deepEqual(await page.evaluate(q(".headCard .reworkCounter")), ["rework round 2 / 3"]);
    send("worker_status", { workerId: "h", status: "completed", verdict: null, worker: { id: "h", reworkRounds: {},
      maxRounds: { impl: 3 }, stage: null } });
    await page.waitFor("!document.querySelector('.headCard')");
  });
});

test("default pipeline line: no rework counter, no stage chip, no wait card", async (t) => {
  const seed = (line) => {
    line.workers.set("a", head("a", { reworkRounds: {}, maxRounds: {}, stage: null }));
    line.workers.set("v", checker("v", "validator", "a"));
  };
  await run(t, null, seed, async (page) => {
    await page.waitFor("document.querySelectorAll('.graph .gnode.worker').length === 2");
    assert.equal(await page.evaluate("document.querySelectorAll('.chainCard, .reworkCounter, [class*=stage-chip], [class*=wait-member]').length"), 0);
    assert.equal(await page.evaluate("document.querySelector('.chainPanel').hidden"), true);
    await fit(page, 1280);
    await page.setViewport(320, 900);
    await fit(page, 320);
  });
});
