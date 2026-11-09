"use strict";
// Real-browser check of the shared harness catalog reload (create panel focus):
// open and reopen, the refresh=1 re-probe, delayed catalog responses filling
// existing rows, installed and absent Claude, saved selections, a visibly
// stale error followed by recovery, and competing reloads. Skipped when no
// Chrome is available.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openPage } = require("./fixtures/browser-driver");

const STUBS = "window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };"
  + "window.marked = { use() {}, parse: (t) => String(t) };"
  + "window.__errs = [];"
  + "window.addEventListener('error', (e) => window.__errs.push(String(e.message)));"
  + "window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));"
  + "const __ce = console.error; console.error = (...a) => { window.__errs.push(a.join(' ')); __ce.apply(console, a); };"
  // The fetch recorder wraps the current impl, so a stub stays counted and a
  // pass-through keeps reaching the real server.
  + "window.__harnessFetches = [];"
  + "window.__harnessInFlight = 0;"
  + "window.__realFetch = window.fetch.bind(window);"
  + "window.__harnessFetchImpl = window.__realFetch;"
  + "window.fetch = (u, o) => {"
  + "  if (!String(u).includes('/api/harnesses')) return window.__realFetch(u, o);"
  + "  window.__harnessFetches.push(String(u));"
  + "  window.__harnessInFlight += 1;"
  // The decrement waits for a macrotask: the page clears its reload slot in
  // microtasks after the response settles, so a zero count must not race it.
  + "  return window.__harnessFetchImpl(u, o).finally(() => {"
  + "    setTimeout(() => { window.__harnessInFlight -= 1; }, 0); });"
  + "};";

// The server kills a probe command after 2 s and then reports the harness as
// not installed. Under CPU load a fake CLI shell script can exceed that, and
// the catalog silently loses claude. The tests control the catalog through
// fake CLIs, so they lift the limit. The server reads it when it first loads.
process.env.CUCK_PROBE_TIMEOUT_MS = "60000";
const { startDashboardFixture } = require("./fixtures/dashboard-browser");

const ROWS = "document.querySelectorAll('#createPanel .phaseRow').length";
const HARNESS_SEL = "document.getElementById('cp-harness-planner')";
const MODEL_SEL = "document.getElementById('cp-model-planner')";
const HARNESS_FETCHES = "window.__harnessFetches.filter((u) => u.includes('/api/harnesses')).length";
const AUTH_SUMMARY = "document.querySelector('#createPanel .authSummary').textContent";
// The full observable state of the harness select: the row build wipes and
// refills the options in microtasks after the probe settles, so the
// assertion must wait for this state to stop changing.
const HARNESS_STATE = `(() => { const s = ${HARNESS_SEL};
  return { value: s.value, count: s.options.length,
    label: s.selectedOptions[0] ? s.selectedOptions[0].textContent : "" }; })()`;
const CLAUDE_CATALOG = { harnesses: [{ id: "claude", installed: true, auth: "ok", version: "2.1.317",
  models: [{ value: "claude-opus-4-5", label: "Opus 4.5" }] }] };
const NO_CLAUDE_CATALOG = { harnesses: [{ id: "vibe", installed: true, auth: "unknown" }] };

const CLAUDE_SCRIPT = '#!/bin/sh\n'
  + 'case "$1" in --version) echo "claude 2.1.317"; exit 0;; auth) exit 0;; esac\nexit 1\n';
const VIBE_SCRIPT = '#!/bin/sh\ncase "$1" in --version) echo "vibe 3.0.2"; exit 0;; esac\nexit 1\n';
const PI_SCRIPT = '#!/bin/sh\ncase "$1" in --version) echo "pi 0.87"; exit 0;; --list-models) exit 1;; esac\nexit 1\n';
const CODEX_SCRIPT = '#!/bin/sh\ncase "$1" in --version) echo "codex 1.0"; exit 0;; login) exit 0;; esac\nexit 1\n';

// Fake CLIs on PATH: the fixture server probes in-process, so the fakes
// shadow the real ones and the catalog is fully controlled by the test.
function writeFakeClis(bin, withClaude) {
  fs.writeFileSync(path.join(bin, "vibe"), VIBE_SCRIPT, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "pi"), PI_SCRIPT, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "codex"), CODEX_SCRIPT, { mode: 0o755 });
  const claudeBin = path.join(bin, "claude");
  if (withClaude) fs.writeFileSync(claudeBin, CLAUDE_SCRIPT, { mode: 0o755 });
  else fs.rmSync(claudeBin, { force: true });
  return claudeBin;
}

const restrictPath = (bin) => {
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  return oldPath;
};

// A stub whose response the test releases by hand: the rows exist before the
// catalog answers, so the delayed fill of the open rows is observable.
const heldResponse = (catalog) => `(() => {
  let release;
  window.__releaseHarness = () => release();
  window.__harnessFetchImpl = () => new Promise((r) => { release = r; })
    .then(() => new Response(JSON.stringify(${JSON.stringify(catalog)}), { status: 200 }));
})()`;

const respondWith = (catalog) => `(() => {
  window.__harnessFetchImpl = () => Promise.resolve(new Response(
    JSON.stringify(${JSON.stringify(catalog)}), { status: 200 }));
})()`;

const harnessValues = (page) =>
  page.evaluate(`[...${HARNESS_SEL}.options].map((o) => o.value)`);

const selectHarness = (page, id) => page.evaluate(`(() => {
  const s = ${HARNESS_SEL}; s.value = ${JSON.stringify(id)};
  s.dispatchEvent(new Event('change'));
})()`);

// Cancel hides the panel and resets the form, so a test starts clean.
const resetForm = async (page) => {
  // The save row also has a Cancel button and precedes the form's own in DOM
  // order: only the form's Cancel (inside .cpBtns, class "row") hides and resets.
  await page.evaluate("[...document.querySelectorAll('#createPanel .row button')]"
    + ".find((b) => b.textContent === 'Cancel').click()");
};

const openCreate = async (page) => {
  await page.evaluate("document.getElementById('create').click()");
  await page.waitFor(`${ROWS} >= 1`);
};

// The probe settled and the form's own row build finished: the fetch was
// recorded, no request is in flight, and the select state is stable across
// two polls, so a mid-chain wipe or a late apply cannot race the assertion.
const waitSettled = async (page, minFetches) => {
  // The real probe runs fake CLIs: on a loaded host it can take longer than
  // the default wait, and the probe limit is lifted, so wait for it.
  await page.waitFor(`${HARNESS_FETCHES} >= ${minFetches} && window.__harnessInFlight === 0`,
    { timeoutMs: 30000 });
  let last = null;
  for (let i = 0; i < 100; i++) {
    const now = JSON.stringify(await page.evaluate(HARNESS_STATE));
    if (now === last) return;
    last = now;
    await page.evaluate("new Promise((r) => setTimeout(r, 100))");
  }
  throw new Error("the form state never settled");
};

test("harness reload: a delayed catalog response fills the open form's rows", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    await page.evaluate(heldResponse(CLAUDE_CATALOG));
    await openCreate(page);
    // The rows exist; the pending response has not filled the harness options.
    assert.ok(!((await harnessValues(page)).includes("claude")));
    assert.equal(await page.evaluate(HARNESS_FETCHES), 1);
    assert.match(await page.evaluate("window.__harnessFetches[0]"), /refresh=1/);
    await page.evaluate("window.__releaseHarness()");
    await page.waitFor(`[...${HARNESS_SEL}.options].some((o) => o.value === 'claude')`);
    await selectHarness(page, "claude");
    const models = await page.evaluate(`[...${MODEL_SEL}.options].map((o) => o.value)`);
    assert.ok(models.includes("claude-opus-4-5"));
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
});

test("harness reload: reopening the form discovers a newly installed harness", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "harness-reload-bin-"));
  const oldPath = restrictPath(bin);
  try {
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    writeFakeClis(bin, false);
    await resetForm(page);
    const before = await page.evaluate(HARNESS_FETCHES);
    await openCreate(page);
    await waitSettled(page, before + 1);
    assert.ok(!((await harnessValues(page)).includes("claude")), "claude is absent before the install");
    writeFakeClis(bin, true);
    await resetForm(page);
    await openCreate(page);
    await waitSettled(page, before + 2);
    assert.ok((await harnessValues(page)).includes("claude"), "the reopen re-probed and found claude");
    await selectHarness(page, "claude");
    const models = await page.evaluate(`[...${MODEL_SEL}.options].map((o) => o.value)`);
    for (const alias of ["opus", "sonnet", "haiku"]) assert.ok(models.includes(alias), alias);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
    if (page) await page.close();
    await fx.close();
  }
});

test("harness reload: saved selections survive a refresh", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "harness-reload-bin-"));
  const oldPath = restrictPath(bin);
  try {
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    writeFakeClis(bin, true);
    await resetForm(page);
    await openCreate(page);
    await waitSettled(page, 1);
    await selectHarness(page, "claude");
    await page.evaluate(`(() => { ${MODEL_SEL}.value = 'sonnet'; })()`);
    // Toggle hides without a reset: the saved selection must survive the reload.
    await page.evaluate("document.getElementById('create').click()");
    await page.evaluate("document.getElementById('create').click()");
    await waitSettled(page, 2);
    assert.equal(await page.evaluate(`${HARNESS_SEL}.value`), "claude");
    assert.equal(await page.evaluate(`${MODEL_SEL}.value`), "sonnet");
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
    if (page) await page.close();
    await fx.close();
  }
});

test("harness reload: an absent harness keeps its saved selection, honestly labeled", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "harness-reload-bin-"));
  const oldPath = restrictPath(bin);
  try {
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    const claudeBin = writeFakeClis(bin, true);
    await resetForm(page);
    await openCreate(page);
    await waitSettled(page, 1);
    await selectHarness(page, "claude");
    await page.evaluate(`(() => { ${MODEL_SEL}.value = 'sonnet'; })()`);
    writeFakeClis(bin, false);
    // Toggle hides without a reset: the saved selection must survive the reload.
    await page.evaluate("document.getElementById('create').click()");
    await page.evaluate("document.getElementById('create').click()");
    await waitSettled(page, 2);
    assert.equal(await page.evaluate(`${HARNESS_SEL}.value`), "claude");
    assert.match(await page.evaluate(`${HARNESS_SEL}.selectedOptions[0].textContent`), /not installed/);
    assert.equal(await page.evaluate(`${MODEL_SEL}.value`), "sonnet");
    // Recovery: the harness is back, the label is plain again. The Cancel
    // reset dropped the saved selection by design; the option is current.
    fs.writeFileSync(claudeBin, CLAUDE_SCRIPT, { mode: 0o755 });
    await resetForm(page);
    await openCreate(page);
    await waitSettled(page, 3);
    assert.equal(await page.evaluate(`${HARNESS_SEL}.value`), "");
    assert.ok((await harnessValues(page)).includes("claude"));
    assert.doesNotMatch(await page.evaluate(`${HARNESS_SEL}.selectedOptions[0].textContent`), /not installed/);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
    if (page) await page.close();
    await fx.close();
  }
});

test("harness reload: a failed load shows a stale error, then recovers", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "harness-reload-bin-"));
  const oldPath = restrictPath(bin);
  try {
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    writeFakeClis(bin, true);
    await resetForm(page);
    await openCreate(page);
    await waitSettled(page, 1);
    await page.evaluate("window.__harnessFetchImpl = () => Promise.resolve(new Response("
      + "JSON.stringify({ error: 'harness probe failed' }), { status: 500 }))");
    await resetForm(page);
    await openCreate(page);
    await waitSettled(page, 2);
    assert.match(await page.evaluate(AUTH_SUMMARY), /Harness catalog load failed \(HTTP 500\)/);
    assert.ok((await harnessValues(page)).includes("claude"), "the previous list is kept under the error");
    await page.evaluate("window.__harnessFetchImpl = window.__realFetch");
    await resetForm(page);
    await openCreate(page);
    await waitSettled(page, 3);
    assert.equal(await page.evaluate(AUTH_SUMMARY), "");
    assert.ok((await harnessValues(page)).includes("claude"), "the recovered list is current");
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
    if (page) await page.close();
    await fx.close();
  }
});

test("harness reload: competing reloads share one request; the newest result wins", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "harness-reload-bin-"));
  const oldPath = restrictPath(bin);
  try {
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    writeFakeClis(bin, true);
    await resetForm(page);
    await openCreate(page);
    await waitSettled(page, 1);
    const before = await page.evaluate(HARNESS_FETCHES);
    await page.evaluate(heldResponse(CLAUDE_CATALOG));
    await resetForm(page);
    await openCreate(page);
    // The held reload was recorded once; the reopen shared it, so an older
    // response cannot race a newer one: one request is in flight at a time.
    assert.equal(await page.evaluate(HARNESS_FETCHES), before + 1);
    await page.evaluate("window.__releaseHarness()");
    await waitSettled(page, before + 1);
    assert.ok((await harnessValues(page)).includes("claude"));
    // A newer reload after the older one settled issues a new request and wins:
    // the stale claude option is rebuilt away, and nothing was selected, so no
    // label applies and the value stays at the default.
    await page.evaluate(respondWith(NO_CLAUDE_CATALOG));
    await resetForm(page);
    await openCreate(page);
    await waitSettled(page, before + 2);
    assert.ok(!((await harnessValues(page)).includes("claude")),
      "the newest result won: the stale claude option is rebuilt away");
    assert.equal(await page.evaluate(`${HARNESS_SEL}.value`), "");
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
    if (page) await page.close();
    await fx.close();
  }
});

// A plugin harness with capabilities.providers gets the same provider
// controls as Pi: its own detail route, models, and auth status text.
const ACME_CATALOG = { harnesses: [{ id: "acme", displayName: "Acme", installed: true,
  auth: "unknown", version: "1.0", plugin: { layer: "user", folder: "acme" },
  capabilities: { providers: true },
  authModes: [{ value: "north", label: "North" }, { value: "south", label: "South" }] }] };
const ACME_DETAIL = { id: "acme", authMode: "north", auth: "ok", loginHint: "",
  models: [{ value: "north/big", label: "North Big" }] };

test("harness reload: a plugin with providers loads its own provider models", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  try {
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    await page.evaluate(`(() => {
      window.__harnessFetchImpl = (u) => Promise.resolve(new Response(
        JSON.stringify(String(u).includes('/api/harnesses/acme?')
          ? ${JSON.stringify(ACME_DETAIL)} : ${JSON.stringify(ACME_CATALOG)}),
        { status: 200 }));
    })()`);
    await openCreate(page);
    await waitSettled(page, 1);
    await selectHarness(page, "acme");
    const AUTH_SEL = "document.getElementById('cp-authmode-planner')";
    assert.equal(await page.evaluate(`${AUTH_SEL}.hidden`), false);
    assert.deepEqual(await page.evaluate(`[...${AUTH_SEL}.options].map((o) => o.value)`),
      ["", "north", "south"]);
    await page.evaluate(`(() => { const s = ${AUTH_SEL}; s.value = 'north';
      s.dispatchEvent(new Event('change')); })()`);
    await page.waitFor(`[...${MODEL_SEL}.options].some((o) => o.value === 'north/big')`);
    assert.ok((await page.evaluate("window.__harnessFetches"))
      .includes("/api/harnesses/acme?provider=north"));
    assert.match(await page.evaluate(
      "document.querySelector('#createPanel .authHint, #createPanel .authHint').textContent"),
      /acme auth ok/);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
});

// A plugin label with its folder title, plus one warning line for failed plugins.
test("harness reload: a plugin is labeled and a plugin problem shows one warning", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  const catalog = { harnesses: [
    { id: "vibe", installed: true, auth: "unknown", version: "3.0.2" },
    { id: "acme", displayName: "Acme", installed: true, auth: "missing", loginHint: "acme login --now",
      version: "1.0", plugin: { layer: "user", folder: "acme-dir" } }],
  pluginProblems: [{ layer: "user", path: "/plugins/broken", errors: ["bad"] }] };
  try {
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    await page.evaluate(`(() => {
      window.__harnessFetchImpl = () => Promise.resolve(new Response(
        JSON.stringify(${JSON.stringify(catalog)}), { status: 200 }));
    })()`);
    await openCreate(page);
    await waitSettled(page, 1);
    assert.deepEqual(await page.evaluate(
      `[...${HARNESS_SEL}.options].filter((o) => o.value).map((o) => o.textContent)`),
      ["vibe (3.0.2)", "Acme (plugin) (1.0)"]);
    assert.equal(await page.evaluate(
      `[...${HARNESS_SEL}.options].find((o) => o.value === 'acme').title`), "acme-dir");
    assert.equal(await page.evaluate(
      "document.querySelector('#createPanel .pluginProblems').textContent"),
      "1 harness plugin(s) failed to load");
    assert.equal(await page.evaluate(
      "document.querySelector('#createPanel .pluginProblems').title"), "/plugins/broken");
    await selectHarness(page, "acme");
    assert.match(await page.evaluate(
      "document.querySelector('#createPanel .authHint').textContent"), /acme login --now/);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    if (page) await page.close();
    await fx.close();
  }
});

// Regression for the load flake: the fake claude answers 3 s late, longer
// than the product's 2 s probe limit. The catalog must still list it.
test("harness reload: a slow probe command does not drop the harness from the catalog", async (t) => {
  const fx = await startDashboardFixture();
  let page = null;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "harness-reload-bin-"));
  const oldPath = restrictPath(bin);
  try {
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    const claudeBin = writeFakeClis(bin, true);
    fs.writeFileSync(claudeBin, CLAUDE_SCRIPT.replace("--version) echo", "--version) sleep 3; echo"),
      { mode: 0o755 });
    await resetForm(page);
    await openCreate(page);
    await waitSettled(page, 1);
    assert.ok((await harnessValues(page)).includes("claude"), "the slow claude is still listed");
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
    if (page) await page.close();
    await fx.close();
  }
});
