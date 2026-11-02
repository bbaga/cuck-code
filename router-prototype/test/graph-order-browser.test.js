"use strict";
// Real-browser check of the line graph order: integration validators sit between the
// lanes they merged, in time order. Skipped when no Chrome is available.
// Screenshots go to GRAPH_ORDER_SHOTS=<dir> when set.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startDashboardFixture } = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");

const STUBS = "window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };"
  + "window.marked = { use() {}, parse: (t) => String(t) };"
  + "window.__errs = [];"
  + "window.addEventListener('error', (e) => window.__errs.push(String(e.message)));";

const impl = (id, name) => ({ id, name, role: "implementor", persona: "backend", status: "completed",
  repo: "api", branch: "b/" + name, runGeneration: 1, transcript: [], children: [] });
const val = (id, name, validates) => ({ id, name, role: "validator", kind: "standard", validates,
  status: "completed", verdict: "pass", transcript: [] });
const integ = (id, name) => ({ id, name, role: "validator", kind: "integration", status: "completed",
  verdict: "pass", transcript: [] });

// order: tokens in creation order; "I:name", "v:name", "G:name"
function seed(line, order) {
  const implId = {};
  for (const tok of order) {
    const [k, name] = tok.split(":");
    let w;
    if (k === "I") { implId[name] = "i-" + name; w = impl("i-" + name, name); }
    else if (k === "v") w = val("v-" + name, name + "-val", "i-" + name);
    else w = integ("g-" + name, name);
    line.workers.set(w.id, w);
  }
}

async function run(t, order, shotName, check) {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    seed(require("../server").lines.get(fx.lineId), order);
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    await page.setViewport(1100, 1100);
    await page.waitFor("/browser[- ]line/i.test(document.body.innerText)");
    await page.waitFor("document.querySelectorAll('.gnode').length >= " + (order.length + 1));
    // Show the whole graph (the panel is normally a scrolling area of at most 300 px).
    await page.evaluate("(() => { const g = document.querySelector('.graph'); g.style.maxHeight = 'none'; g.style.height = g.scrollHeight + 'px'; })()");
    const nodes = await page.evaluate(`[...document.querySelectorAll('.gnode')].map((n) => {
      const r = n.getBoundingClientRect();
      return { text: (n.querySelector('.nodeName') || n).textContent.trim(), cls: n.className, left: n.offsetLeft, top: n.offsetTop,
        w: n.offsetWidth, h: n.offsetHeight }; })`);
    const shots = process.env.GRAPH_ORDER_SHOTS;
    if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot(path.join(shots, shotName)); }
    // nothing overlaps
    for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
      const p = nodes[a], q = nodes[b];
      const overlap = p.left < q.left + q.w && q.left < p.left + p.w && p.top < q.top + q.h && q.top < p.top + p.h;
      assert.equal(overlap, false, `${p.text} overlaps ${q.text}`);
    }
    assert.deepEqual(await page.evaluate("window.__errs"), []);
    check(nodes);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
}

const top = (nodes, name) => {
  const n = nodes.find((x) => x.text === name);
  assert.ok(n, "node " + name);
  return n.top;
};

test("graph order: two old-style integrations sit between the lanes they merged", async (t) => {
  await run(t, ["I:a", "I:b", "v:a", "v:b", "G:int1", "I:c", "v:c", "G:int2", "I:d", "v:d"], "graph-order-1100.png", (nodes) => {
    const g1 = top(nodes, "int1"), g2 = top(nodes, "int2");
    assert.ok(g1 < g2, "integrations in time order");
    assert.ok(top(nodes, "b") < g1 && g1 < top(nodes, "c"), "int1 between lane b and lane c");
    assert.ok(top(nodes, "c") < g2 && g2 < top(nodes, "d"), "int2 between lane c and lane d");
    const integrationLeft = nodes.find((x) => x.text === "int1").left;
    assert.equal(nodes.find((x) => x.text === "int2").left, integrationLeft, "same column");
  });
});

test("graph order: a long line with four integrations, restart order (implementors first)", async (t) => {
  await run(t, ["I:a", "I:b", "I:c", "I:d", "v:a", "v:b", "G:int1", "v:c", "G:int2", "v:d", "G:int3", "G:int4", "I:e", "v:e", "G:int5"],
    "graph-order-long-1100.png", (nodes) => {
      const tops = [1, 2, 3, 4, 5].map((n) => top(nodes, "int" + n));
      for (let i = 1; i < tops.length; i++) assert.ok(tops[i] > tops[i - 1], "increasing top");
      assert.ok(top(nodes, "d") < tops[2] && tops[3] < top(nodes, "e"), "int3 and int4 follow lane d, above lane e");
      assert.ok(tops[4] > top(nodes, "e"), "int5 follows lane e");
    });
});
