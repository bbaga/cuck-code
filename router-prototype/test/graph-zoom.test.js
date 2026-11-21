"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { clampZoom, stepZoom, fitZoom, zoomScrollOffset, readStoredSize, writeStoredSize,
  ZOOM_MIN, ZOOM_MAX } = require("../web/pipeline-ui.js");

const memory = (init = {}) => {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
};

test("clampZoom keeps whole percents inside 25..300", () => {
  assert.equal(clampZoom(10), 25);
  assert.equal(clampZoom(900), 300);
  assert.equal(clampZoom(124.6), 125);
  assert.equal(clampZoom(NaN), 100);
  assert.equal(clampZoom(Infinity), 100);
});

test("stepZoom zooms in and out by 1.25", () => {
  assert.equal(stepZoom(100, 1), 125);
  assert.equal(stepZoom(100, -1), 80);
  assert.equal(stepZoom(ZOOM_MAX, 1), ZOOM_MAX);
  assert.equal(stepZoom(ZOOM_MIN, -1), ZOOM_MIN);
  assert.equal(stepZoom(250, 1), ZOOM_MAX);
});

test("stepZoom changes the value whenever it is not at a limit", () => {
  for (let z = ZOOM_MIN; z <= ZOOM_MAX; z++) {
    if (z < ZOOM_MAX) assert.ok(stepZoom(z, 1) > z, "in from " + z);
    if (z > ZOOM_MIN) assert.ok(stepZoom(z, -1) < z, "out from " + z);
  }
});

test("fitZoom fits the width and clamps", () => {
  assert.equal(fitZoom(1000, 750), 75);
  assert.equal(fitZoom(1000, 100), 25);
  assert.equal(fitZoom(100, 1000), 300);
  assert.equal(fitZoom(0, 500), 100);
  assert.equal(fitZoom(-5, 500), 100);
  assert.equal(fitZoom(NaN, 500), 100);
  assert.equal(fitZoom(500, NaN), 100);
});

test("zoomScrollOffset keeps the point under the pointer fixed", () => {
  const scroll = 200, pointer = 50, from = 100, to = 150;
  const next = zoomScrollOffset(scroll, pointer, from, to);
  assert.equal((next + pointer) / to, (scroll + pointer) / from);
  assert.equal(zoomScrollOffset(0, 0, 100, 50), 0);
  assert.equal(zoomScrollOffset(0, 80, 100, 50), 0);
});

test("the stored zoom round-trips as a whole percent", () => {
  const s = memory();
  assert.equal(readStoredSize(s, "cuck.pipeZoom.l1", ZOOM_MIN, ZOOM_MAX), null);
  writeStoredSize(s, "cuck.pipeZoom.l1", 125);
  assert.equal(s.getItem("cuck.pipeZoom.l1"), "125");
  assert.equal(readStoredSize(s, "cuck.pipeZoom.l1", ZOOM_MIN, ZOOM_MAX), 125);
  assert.equal(readStoredSize(memory({ k: "900" }), "k", ZOOM_MIN, ZOOM_MAX), 300);
});

test("the pages call attachGraphZoom", () => {
  for (const f of ["../web/index.html", "../web/pipelines-page.js"]) {
    assert.match(fs.readFileSync(require.resolve(f), "utf8"), /attachGraphZoom/);
  }
});
