"use strict";
// Browser checks of a drawn choreographed graph. They run in the page with page.evaluate.
// `root` is a CSS selector of the element that holds the graph: "#graphBox" or ".pipePane".
const assert = require("node:assert/strict");

const CHAIN_EDGE_LINES = [
  "planner -> impl: start, feedback, accept", "impl -> val: handoff", "impl -> planner: report",
  "val -> impl: rework", "val -> batch: arrive", "val -> planner: report", "planner -> batch: start",
  "batch -> integration: handoff", "batch -> planner: report", "planner -> integration: start",
  "integration -> planner: report", "impl -> val: checks", "impl -> integration: accepted work",
];

// Computed stroke-dasharray of the first edge of each style, and the label texts.
async function checkEdgeStyles(page, root) {
  const dash = (cls) => page.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(root + " path.pgEdge." + cls)})).strokeDasharray`);
  assert.notEqual(await dash("edge-rework"), "none", "rework is dashed");
  assert.equal(await dash("edge-handoff"), "none", "handoff is solid");
  assert.equal(await dash("edge-arrive"), "none", "arrive is solid");
  const labels = await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(root + " .pgEdgeLabel")})].map((l) => l.textContent)`);
  assert.ok(labels.includes("rework (FAIL)"), labels.join("|"));
  assert.ok(labels.includes("arrive (PASS)"), labels.join("|"));
}

// The fan-out of pipeline 2: val and lint share one x position, impl has two separate handoff edges.
async function checkStage(page, root) {
  const x = (id) => page.evaluate(`document.querySelector(${JSON.stringify(root + " [data-node=" + id + "] rect")}).getAttribute('x')`);
  assert.equal(await x("val"), await x("lint"), "one column");
  const out = await page.evaluate(`(() => {
    const impl = document.querySelector(${JSON.stringify(root + " [data-node=impl] rect")});
    const startX = Number(impl.getAttribute('x')) + Number(impl.getAttribute('width'));
    return [...document.querySelectorAll(${JSON.stringify(root + " path.pgEdge.edge-handoff")})]
      .map((p) => p.getAttribute('d')).filter((d) => d.startsWith('M' + startX + ' '));
  })()`);
  assert.equal(out.length, 2, "two handoff edges leave impl");
  assert.notEqual(out[0], out[1]);
}

// No page scroll sideways, and no edge label box over a node box.
async function checkFit(page, root, width) {
  assert.ok(await page.evaluate(`document.documentElement.scrollWidth <= ${width}`), `no page scroll at ${width} px`);
  const hits = await page.evaluate(`(() => {
    const boxes = [...document.querySelectorAll(${JSON.stringify(root + " .pgNode rect")})].map((r) => [r.dataset.id, r.getBoundingClientRect()]);
    const bad = [];
    for (const label of document.querySelectorAll(${JSON.stringify(root + " .pgEdgeLabel")})) {
      const a = label.getBoundingClientRect();
      for (const [, b] of boxes) {
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) bad.push(label.textContent);
      }
    }
    return bad;
  })()`);
  assert.deepEqual(hits, [], "labels over nodes");
}

// Scroll the graph box to its right end.
const scrollRight = (page, selector) => page.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); b.scrollLeft = b.scrollWidth; })()`);

// Delete managed test pipelines through the router API, so the server rebuilds its catalog.
// The server keeps the folder of the first fixture, so a direct file delete would miss it.
// Then assert that GET /api/pipelines no longer lists them.
async function removeManaged(baseUrl, names) {
  for (const name of names) {
    const res = await fetch(`${baseUrl}/api/pipelines/${name}`, { method: "DELETE" });
    assert.ok(res.status === 200 || res.status === 404, `delete ${name}: ${res.status}`);
  }
  const list = await (await fetch(`${baseUrl}/api/pipelines`)).json();
  const listed = list.pipelines.map((p) => p.name);
  for (const name of names) assert.ok(!listed.includes(name), `${name} is still listed`);
}

module.exports = { CHAIN_EDGE_LINES, checkEdgeStyles, checkStage, checkFit, scrollRight, removeManaged };
