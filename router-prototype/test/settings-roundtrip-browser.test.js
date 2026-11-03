"use strict";
// Real-browser check of the Change settings round trip: every saved selection
// (Pi provider, provider-qualified model, effort, max context, hidden
// timeLimit) comes back in the Pipeline tab's form, Revert restores it, and a
// no-op Save keeps the stored settings. Covers two different Pi providers, a
// provider the catalog does not know, and a delayed provider answer where a
// manual edit wins. Skipped when no Chrome is available.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startDashboardFixture } = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");
const { loadBuiltinPipeline } = require("../line-graph");

const ROOT = path.join(__dirname, "..");
const PANE = "document.querySelector('.pipePane')";
const SEL = (kind, node) => `document.getElementById('lp-browser-line-${kind}-${node}')`;
const STATE = `(() => ({
  plannerHarness: ${SEL("harness", "planner")}.value,
  plannerMode: ${SEL("authmode", "planner")}.value,
  plannerModeLabel: ${SEL("authmode", "planner")}.selectedOptions[0].textContent,
  plannerModel: ${SEL("model", "planner")}.value,
  plannerModelLabel: ${SEL("model", "planner")}.selectedOptions[0].textContent,
  implMode: ${SEL("authmode", "backend-impl")}.value,
  implModel: ${SEL("model", "backend-impl")}.value,
  valMode: ${SEL("authmode", "backend-val")}.value,
  valModeLabel: ${SEL("authmode", "backend-val")}.selectedOptions[0].textContent,
  valModel: ${SEL("model", "backend-val")}.value,
  plannerEffort: ${SEL("effort", "planner")}.value,
  implEffort: ${SEL("effort", "backend-impl")}.value,
  plannerMaxCtx: ${SEL("maxctx", "planner")}.value }))()`;

const STUBS = "window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };"
  + "window.marked = { use() {}, parse: (t) => String(t) };"
  + "window.__errs = []; window.__puts = []; window.__piFetches = []; window.__piInFlight = 0;"
  + "window.addEventListener('error', (e) => window.__errs.push(String(e.message)));"
  + "window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));"
  + "const __ce = console.error; console.error = (...a) => { window.__errs.push(a.join(' ')); __ce.apply(console, a); };"
  + "const __f = window.fetch; window.fetch = (url, opts) => {"
  + " const u = String(url);"
  + " let p = __f.call(window, url, opts);"
  + " if (u.includes('/api/harnesses/pi')) {"
  + "  window.__piFetches.push(u); window.__piInFlight += 1;"
  + "  p = p.finally(() => { setTimeout(() => { window.__piInFlight -= 1; }, 0); });"
  + " }"
  + " if (opts && opts.method === 'PUT' && /\\/pipeline$/.test(u)) window.__puts.push({ url: u, body: opts.body });"
  + " return p; };";

// Saved settings under test: two different Pi providers, a provider the
// catalog does not know, and every other field the form shows.
const NODE_SETTINGS = {
  planner: { harness: "pi", model: "openai/gpt-5.2", effort: "high", maxContext: 200000, timeLimit: 1234 },
  "backend-impl": { harness: "pi", model: "anthropic/claude-x", effort: "low" },
  "backend-val": { harness: "pi", model: "unknownprov/model-9" },
};

const VIBE_SCRIPT = '#!/bin/sh\ncase "$1" in --version) echo "vibe 3.0.2"; exit 0;; esac\nexit 1\n';
const CODEX_SCRIPT = '#!/bin/sh\ncase "$1" in --version) echo "codex 1.0"; exit 0;; login) exit 0;; esac\nexit 1\n';
// Two providers in the catalog; `pi auth check` always ok.
const PI_SCRIPT = '#!/bin/sh\n'
  + 'case "$1" in\n'
  + '  --version) echo "pi 0.87"; exit 0;;\n'
  + '  --list-models) printf "provider model ctx\\nopenai gpt-5.2 400000\\nopenai gpt-5.1 400000\\nanthropic claude-x 200000\\n"; exit 0;;\n'
  + '  auth) exit 0;;\nesac\nexit 1\n';

function writeFakeClis(bin) {
  fs.writeFileSync(path.join(bin, "vibe"), VIBE_SCRIPT, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "pi"), PI_SCRIPT, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "codex"), CODEX_SCRIPT, { mode: 0o755 });
}

const restrictPath = (bin) => {
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  return oldPath;
};

const clickTab = (page) => page.evaluate(
  "[...document.querySelectorAll('button.tabBtn')].find((b) => b.textContent === 'Pipeline').click()");

const clickFormButton = (page, name) => page.evaluate(
  `[...${PANE}.querySelectorAll('.pipeBtns button')].find((b) => b.textContent === '${name}').click()`);

const changeSelect = (page, kind, node, value) => page.evaluate(`(() => {
  const s = ${SEL(kind, node)}; s.value = ${JSON.stringify(value)};
  s.dispatchEvent(new Event('change')); })()`);

// The form fills in waves (catalog, then per-provider answers): tests wait
// for the expected final state, so a late apply cannot race the asserts.
const waitForState = (page, expr) => page.waitFor(expr, { timeoutMs: 10000 });

// Hold the provider=openai detail answer, so the hydration race is observable.
const holdPiDetail = `(() => {
  let release;
  window.__releasePi = () => release();
  const real = window.fetch;
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('provider=openai')) {
      window.__piFetches.push(u);
      return new Promise((r) => { release = r; }).then(() => new Response(
        JSON.stringify({ id: 'pi', authMode: 'openai', auth: 'ok', loginHint: '', models: [
          { value: 'openai/gpt-5.2', label: 'gpt-5.2' },
          { value: 'openai/gpt-5.1', label: 'gpt-5.1' } ] }), { status: 200 }));
    }
    return real(url, opts);
  };
})()`;

test("settings round trip: saved Pi providers, models, effort, max context and timeLimit are restored", async (t) => {
  const fx = await startDashboardFixture();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "settings-roundtrip-bin-"));
  const oldPath = restrictPath(bin);
  let page = null;
  try {
    writeFakeClis(bin);
    const line = require("../server").lines.get(fx.lineId);
    line.graph = loadBuiltinPipeline("default", fs, ROOT);
    line.nodeSettings = JSON.parse(JSON.stringify(NODE_SETTINGS));
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    await page.setViewport(1100, 1100);
    await page.waitFor("/browser[- ]line/i.test(document.body.innerText)");
    await clickTab(page);
    await page.waitFor(`${PANE} && !${PANE}.hidden && ${PANE}.querySelector('svg.pipeGraph')`);
    // The Pi provider comes back from the provider-qualified saved model,
    // once the catalog and the per-provider answers have arrived.
    await waitForState(page, `${SEL("authmode", "planner")}.value === 'openai'`);
    await waitForState(page, `${SEL("model", "planner")}.selectedOptions[0].textContent === 'gpt-5.2'`);
    await waitForState(page, `${SEL("authmode", "backend-impl")}.value === 'anthropic'`);
    await waitForState(page, `${SEL("model", "backend-impl")}.value === 'anthropic/claude-x'`);
    await waitForState(page, `${SEL("authmode", "backend-val")}.value === 'unknownprov'`);
    const state = await page.evaluate(STATE);

    assert.equal(state.plannerHarness, "pi");
    assert.equal(state.plannerMode, "openai");
    assert.equal(state.plannerModel, "openai/gpt-5.2");
    assert.equal(state.plannerModelLabel, "gpt-5.2", "the catalog label replaces the raw id");
    // A second, different provider on another node.
    assert.equal(state.implMode, "anthropic");
    assert.equal(state.implModel, "anthropic/claude-x");
    // A provider the catalog does not know stays selected, honestly labeled.
    assert.equal(state.valMode, "unknownprov");
    assert.match(state.valModeLabel, /unknownprov \(not in catalog\)/);
    assert.equal(state.valModel, "unknownprov/model-9");
    // The other fields.
    assert.equal(state.plannerEffort, "high");
    assert.equal(state.implEffort, "low");
    assert.equal(state.plannerMaxCtx, "200K");
    // The unknown provider was never fetched; the known ones were.
    const piFetches = await page.evaluate("window.__piFetches");
    assert.ok(piFetches.some((u) => u.includes("provider=openai")), "openai detail fetched");
    assert.ok(piFetches.some((u) => u.includes("provider=anthropic")), "anthropic detail fetched");
    assert.ok(!piFetches.some((u) => u.includes("provider=unknownprov")), "unknown provider not fetched");

    // Revert: manual edits to the provider and effort are undone, the saved
    // provider and model come back.
    await changeSelect(page, "effort", "planner", "low");
    await changeSelect(page, "authmode", "planner", "anthropic");
    await clickFormButton(page, "Revert");
    await waitForState(page, `${SEL("authmode", "planner")}.value === 'openai'`);
    await waitForState(page, `${SEL("model", "planner")}.selectedOptions[0].textContent === 'gpt-5.2'`);
    await waitForState(page, `${SEL("effort", "planner")}.value === 'high'`);
    const reverted = await page.evaluate(STATE);
    assert.equal(reverted.plannerMode, "openai");
    assert.equal(reverted.plannerModel, "openai/gpt-5.2");
    assert.equal(reverted.plannerEffort, "high");

    // No-op Save: the submitted body and the stored settings keep every
    // field, including the hidden timeLimit.
    await clickFormButton(page, "Save settings");
    await page.waitFor(`/Saved\\. The settings apply from the next run\\./.test(${PANE}.innerText)`);
    const puts = await page.evaluate("window.__puts");
    assert.equal(puts.length, 1);
    assert.deepEqual(JSON.parse(puts[0].body), { nodeSettings: NODE_SETTINGS });
    assert.deepEqual(line.nodeSettings, NODE_SETTINGS);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
    if (page) await page.close();
    await fx.close();
  }
});

test("settings round trip: a delayed provider answer re-applies the saved model; a manual edit wins", async (t) => {
  const fx = await startDashboardFixture();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "settings-roundtrip-bin-"));
  const oldPath = restrictPath(bin);
  let page = null;
  try {
    writeFakeClis(bin);
    const line = require("../server").lines.get(fx.lineId);
    line.graph = loadBuiltinPipeline("default", fs, ROOT);
    line.nodeSettings = { planner: { harness: "pi", model: "openai/gpt-5.2", effort: "high" } };
    try { page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
    await page.setViewport(1100, 1100);
    await page.waitFor("/browser[- ]line/i.test(document.body.innerText)");
    await page.evaluate(holdPiDetail);
    await clickTab(page);
    await page.waitFor(`${PANE} && !${PANE}.hidden`);
    // The provider is restored at once; the answer is still held.
    await page.waitFor("window.__piFetches.some((u) => u.includes('provider=openai'))");
    await page.waitFor(`${SEL("authmode", "planner")}.value === 'openai'`);
    // While the answer is in flight the model shows the default or the raw
    // saved id — never another model.
    const inFlight = await page.evaluate(`${SEL("model", "planner")}.value`);
    assert.ok(inFlight === "" || inFlight === "openai/gpt-5.2", "honest in-flight model: " + inFlight);
    // Release: the saved model survives, now with its catalog label.
    await page.evaluate("window.__releasePi()");
    await page.waitFor(`${SEL("model", "planner")}.selectedOptions[0].textContent === 'gpt-5.2'`);
    assert.equal(await page.evaluate(`${SEL("model", "planner")}.value`), "openai/gpt-5.2");

    // A manual edit while a later answer is in flight must win: switch the
    // provider away and back via Revert (a fresh hydration, held), then pick
    // the default while the answer is in flight — it must not be forced back.
    await changeSelect(page, "authmode", "planner", "anthropic");
    await page.waitFor(`${SEL("model", "planner")}.value === ''`, { timeoutMs: 5000 });
    const heldBefore = await page.evaluate("window.__piFetches.length");
    await page.evaluate(holdPiDetail);
    await clickFormButton(page, "Revert");
    await page.waitFor(`window.__piFetches.length > ${heldBefore}`);
    await page.waitFor(`${SEL("model", "planner")}.value === 'openai/gpt-5.2'`);
    await changeSelect(page, "model", "planner", "");
    await page.evaluate("window.__releasePi()");
    await page.waitFor(`${SEL("model", "planner")}.options.length > 1`, { timeoutMs: 5000 });
    assert.equal(await page.evaluate(`${SEL("model", "planner")}.value`), "",
      "the manual edit wins over the stale hydration");
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
    if (page) await page.close();
    await fx.close();
  }
});
