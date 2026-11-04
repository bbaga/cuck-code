"use strict";
// Real-browser check of the settings round trip: creation selections reach
// the persisted nodeSettings and come back in Change settings; a no-op Save
// keeps the stored settings; late or failed answers cannot corrupt it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startDashboardFixture } = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");
const { loadBuiltinPipeline } = require("../line-graph");

const ROOT = path.join(__dirname, "..");
// Line creation runs `git commit`: ignore a global GPG-sign git config.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

const PANE = (line) => `document.querySelector('.card[data-line-id="${line}"] .pipePane')`;
const SEL = (prefix, kind, node) => `document.getElementById('${prefix}-${kind}-${node}')`;
// Full observable state of one line's settings form (prefix "lp-<lineId>").
const STATE = (line) => { const p = "lp-" + line, S = (k, n) => SEL(p, k, n);
  return `(() => ({ harness: ${S("harness", "planner")}.value, model: ${S("model", "planner")}.value,
  modelLabel: ${S("model", "planner")}.selectedOptions[0].textContent,
  implMode: ${S("authmode", "backend-impl")}.value, implModel: ${S("model", "backend-impl")}.value,
  implEffort: ${S("effort", "backend-impl")}.value, valModel: ${S("model", "backend-val")}.value,
  valModeLabel: ${S("authmode", "backend-val")}.selectedOptions[0].textContent,
  bareMode: ${S("authmode", "frontend-impl")}.value, bareModel: ${S("model", "frontend-impl")}.value,
  intHarness: ${S("harness", "integration")}.value, intModel: ${S("model", "integration")}.value,
  valMaxCtx: ${S("maxctx", "backend-val")}, intMaxCtx: ${S("maxctx", "integration")},
  effort: ${S("effort", "planner")}.value, maxCtx: ${S("maxctx", "planner")}.value }))()`; };
const STUBS = "window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };"
  + "window.marked = { use() {}, parse: (t) => String(t) };"
  + "window.__errs = []; window.__puts = []; window.__piFetches = [];"
  + "window.addEventListener('error', (e) => window.__errs.push(String(e.message)));"
  + "window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));"
  + "const __ce = console.error; console.error = (...a) => { window.__errs.push(a.join(' ')); __ce.apply(console, a); };"
  + "const __f = window.fetch; window.fetch = (url, opts) => { const u = String(url);"
  + " let p = __f.call(window, url, opts);"
  + " if (u.includes('/api/harnesses')) p = p.finally(() => { setTimeout(() => {"
  + "  window.__harnessDone = (window.__harnessDone || 0) + 1; }, 0); });"
  + " if (opts && opts.method === 'PUT' && /\\/pipeline$/.test(u)) window.__puts.push({ url: u, body: opts.body });"
  + " return p; };";
const PI_SCRIPT = '#!/bin/sh\n'
  + 'case "$1" in\n'
  + '  --version) echo "pi 0.87"; exit 0;;\n'
  + '  --list-models) printf "provider model ctx\\nopenai-codex gpt-5.2 400000\\nopenai-codex gpt-5.1 400000\\nanthropic claude-x 200000\\n"; exit 0;;\n'
  + '  auth) exit 0;;\nesac\nexit 1\n';
// Fixture with a fake pi CLI, an optional line seed, and a ready page; the
// holder survives a run() that swaps the page.
async function withFixture(t, seed, run) {
  const fx = await startDashboardFixture();
  const oldPath = process.env.PATH,
    bin = fs.mkdtempSync(path.join(os.tmpdir(), "settings-roundtrip-bin-"));
  process.env.PATH = `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  fs.writeFileSync(path.join(bin, "pi"), PI_SCRIPT, { mode: 0o755 });
  if (seed) seed(require("../server").lines.get(fx.lineId));
  const holder = { page: null };
  try {
    try { holder.page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e; }
    await holder.page.setViewport(1100, 1100);
    await holder.page.waitFor("/browser[- ]line/i.test(document.body.innerText)");
    await run(holder, fx);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
    if (holder.page) await holder.page.close();
    await fx.close();
  }
}
const clickTab = (page, line, name = "Pipeline") => page.evaluate(
  `[...document.querySelector('.card[data-line-id="${line}"]').querySelectorAll('button.tabBtn')].find((b) => b.textContent === '${name}').click()`);
const clickFormButton = (page, line, name) => page.evaluate(
  `[...${PANE(line)}.querySelectorAll('.pipeBtns button')].find((b) => b.textContent === '${name}').click()`);
const changeSelect = (page, prefix, kind, node, value) => page.evaluate(`(() => {
  const s = ${SEL(prefix, kind, node)}; s.value = ${JSON.stringify(value)};
  s.dispatchEvent(new Event('change')); })()`);
// Open the create panel and pick pi + openai-codex on the planner.
const openCreatePlannerPi = async (page) => {
  await page.evaluate("document.getElementById('create').click()");
  await page.waitFor("document.querySelectorAll('#createPanel .phaseRow').length === 6");
  await waitOption(page, "cp-harness-planner", "pi");
  await changeSelect(page, "cp", "harness", "planner", "pi");
  await changeSelect(page, "cp", "authmode", "planner", "openai-codex");
};
// The form fills in waves: waits cover the races; absence of a late effect
// is proven by bounded polling, never by a sleep.
const wait = (page, expr) => page.waitFor(expr, { timeoutMs: 10000 });
const waitAll = (page, exprs) => page.waitFor(exprs.join(" && "), { timeoutMs: 10000 });
const waitOption = (page, id, value) => wait(page,
  `[...document.getElementById('${id}').options].some((o) => o.value === '${value}')`);
const waitSaved = (page, line) => page.waitFor(
  `/Saved\\. The settings apply from the next run\\./.test(${PANE(line)}.innerText)`);
const waitNever = async (page, badExpr, polls = 10) => {
  for (let i = 0; i < polls; i++) {
    assert.ok(!await page.evaluate(badExpr), "the rejected effect appeared: " + badExpr);
    await page.evaluate("new Promise((r) => setTimeout(r, 50))");
  }
};
// Page-side core shared by the pi stubs: an openai-codex answer can be held
// at the fetch and again at the JSON body; release handles land in
// window.__releases / window.__jsonReleases. Per call, answer() returns
// { hold, models, status, body }.
const HELD_PI_CORE = `(() => {
  window.__releases = []; window.__jsonReleases = [];
  window.__fetchReleased = 0; window.__jsonReleased = 0;
  const real = window.fetch;
  const body = (models) => JSON.stringify(
    { id: 'pi', authMode: 'openai-codex', auth: 'ok', models });
  const held = (models) => new Promise((r) => window.__releases.push(() => {
    window.__fetchReleased += 1; r(); }))
    .then(() => new Response(new ReadableStream({ start(c) {
      const enc = new TextEncoder();
      window.__jsonReleases.push(() => { window.__jsonReleased += 1;
        c.enqueue(enc.encode(body(models))); c.close(); });
    } }), { status: 200 }));
  window.__heldPi = (answer) => {
    window.fetch = (url, opts) => {
      const u = String(url);
      if (!u.includes('provider=openai-codex')) return real(url, opts);
      window.__piFetches.push(u);
      const a = answer();
      return a.hold ? held(a.models) : Promise.resolve(
        new Response(a.body || body(a.models), { status: a.status || 200 }));
    };
  };
})()`;

// Every openai-codex answer is held; call n answers with body n.
const holdPiFetchAndJson = HELD_PI_CORE + `;(() => {
  window.__heldCalls = 0;
  const bodies = [[{ value: 'openai-codex/gpt-old', label: 'gpt-old' }],
    [{ value: 'openai-codex/gpt-new-a', label: 'gpt-new-a' },
      { value: 'openai-codex/gpt-new-b', label: 'gpt-new-b' }]];
  window.__heldPi(() => ({ hold: true,
    models: bodies[Math.min(window.__heldCalls++, bodies.length - 1)] }));
})()`;
// openai-codex detail calls: two HTTP 500 failures, then a held success
// (fetch and JSON body), then immediate successes.
const failHoldSucceedPi = HELD_PI_CORE + `;(() => {
  window.__piCalls = 0;
  const ok = [{ value: 'openai-codex/gpt-5.2', label: 'gpt-5.2' }];
  window.__heldPi(() => {
    const n = window.__piCalls++;
    if (n < 2) return { status: 500, body: JSON.stringify({ error: 'pi detail exploded' }) };
    return { hold: n === 2, models: ok };
  });
})()`;
test("settings round trip: creation selections reach nodeSettings and Change settings", async (t) => {
  await withFixture(t, null, async (holder, fx) => {
    let page = holder.page;
    // Create: pi + openai-codex planner, pi + anthropic backend-impl.
    await openCreatePlannerPi(page);
    await waitOption(page, "cp-model-planner", "openai-codex/gpt-5.2");
    await changeSelect(page, "cp", "model", "planner", "openai-codex/gpt-5.2");
    await changeSelect(page, "cp", "effort", "planner", "high");
    await changeSelect(page, "cp", "maxctx", "planner", "200K");
    await changeSelect(page, "cp", "harness", "backend-impl", "pi");
    await changeSelect(page, "cp", "authmode", "backend-impl", "anthropic");
    await waitOption(page, "cp-model-backend-impl", "anthropic/claude-x");
    await changeSelect(page, "cp", "model", "backend-impl", "anthropic/claude-x");
    await changeSelect(page, "cp", "effort", "backend-impl", "low");
    await page.evaluate("document.getElementById('cp-name').value = 'Round trip line';"
      + " [...document.querySelectorAll('#createPanel button')]"
      + ".find((b) => b.textContent === 'Create line').click()");
    await page.waitFor("[...document.querySelectorAll('.card')]"
      + ".some((c) => c.dataset.lineId !== 'browser-line')");
    // Persisted result: explicit overrides only; defaults absent.
    const created = (await (await fetch(`${fx.url}/api/lines`)).json())
      .lines.find((l) => l.name === "Round trip line");
    assert.ok(created, "the created line is listed");
    const expected = {
      planner: { harness: "pi", model: "openai-codex/gpt-5.2", effort: "high", maxContext: 200000 },
      "backend-impl": { harness: "pi", model: "anthropic/claude-x", effort: "low" } };
    assert.deepEqual(created.nodeSettings, expected);
    // Seed timeLimit, an unknown provider, and a bare model via the API.
    expected.planner.timeLimit = 1234;
    expected["backend-val"] = { harness: "pi", model: "unknownprov/model-9" };
    expected["frontend-impl"] = { harness: "pi", model: "gpt-5.2-bare" };
    const put = await fetch(`${fx.url}/api/lines/${created.id}/pipeline`, { method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeSettings: expected }) });
    assert.equal(put.status, 200);

    // Fresh session: reopen the dashboard and the new line's settings.
    await page.close();
    holder.page = page = await openPage(fx.url, { initScript: STUBS });
    await page.waitFor("/Round trip line/i.test(document.body.innerText)");
    await clickTab(page, created.id);
    await wait(page, `${PANE(created.id)} && !${PANE(created.id)}.hidden`);
    const pre = "lp-" + created.id;
    await waitAll(page, [
      `${SEL(pre, "authmode", "planner")}.value === 'openai-codex'`,
      `${SEL(pre, "model", "planner")}.selectedOptions[0].textContent === 'gpt-5.2'`,
      `${SEL(pre, "authmode", "backend-impl")}.value === 'anthropic'`,
      `${SEL(pre, "authmode", "backend-val")}.value === 'unknownprov'`]);
    // Every supported field restored: the catalog label replaces the raw
    // id; an unknown provider stays selected, honestly labeled; a bare
    // model keeps its raw value, no guessed provider; defaults stay default;
    // fresh-session nodes have no max context control.
    assert.deepEqual(await page.evaluate(STATE(created.id)), {
      harness: "pi", model: "openai-codex/gpt-5.2", modelLabel: "gpt-5.2", effort: "high", maxCtx: "200K",
      implMode: "anthropic", implModel: "anthropic/claude-x", implEffort: "low",
      valModel: "unknownprov/model-9", valModeLabel: "unknownprov (not in catalog)",
      bareMode: "", bareModel: "gpt-5.2-bare",
      intHarness: "", intModel: "", valMaxCtx: null, intMaxCtx: null });

    // Revert: manual edits to the provider and effort are undone.
    await changeSelect(page, pre, "effort", "planner", "low");
    await changeSelect(page, pre, "authmode", "planner", "anthropic");
    await clickFormButton(page, created.id, "Revert");
    await waitAll(page, [
      `${SEL(pre, "authmode", "planner")}.value === 'openai-codex'`,
      `${SEL(pre, "model", "planner")}.selectedOptions[0].textContent === 'gpt-5.2'`,
      `${SEL(pre, "effort", "planner")}.value === 'high'`]);
    // No-op Save: the body keeps every field, including the hidden
    // timeLimit and the bare model; default nodes add nothing.
    await clickFormButton(page, created.id, "Save settings");
    await waitSaved(page, created.id);
    const puts = await page.evaluate("window.__puts");
    assert.equal(puts.length, 1);
    assert.deepEqual(JSON.parse(puts[0].body), { nodeSettings: expected });
    const after = await (await fetch(`${fx.url}/api/lines`)).json();
    assert.deepEqual(after.lines.find((l) => l.id === created.id).nodeSettings, expected);

    // Reopen (tab away and back): reload completes, no refetch, values stay.
    const [fetchesBefore, doneBefore] = await page.evaluate(
      "[window.__piFetches.length, window.__harnessDone || 0]");
    await clickTab(page, created.id, "Line");
    await clickTab(page, created.id);
    await page.waitFor(`(window.__harnessDone || 0) > ${doneBefore}`);
    await waitNever(page, `window.__piFetches.length !== ${fetchesBefore}`
      + ` || ${SEL(pre, "model", "planner")}.value !== 'openai-codex/gpt-5.2'`
      + ` || ${SEL(pre, "model", "frontend-impl")}.value !== 'gpt-5.2-bare'`);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  });
});

test("settings round trip: a rebuilt row rejects the old row's answer even after its JSON parses", async (t) => {
  await withFixture(t, null, async (holder) => {
    const page = holder.page; await page.evaluate(holdPiFetchAndJson);
    await openCreatePlannerPi(page);
    await page.waitFor("window.__releases.length === 1");
    // The old answer's headers arrive; its JSON body stays held.
    await page.evaluate("window.__releases[0]()");
    await page.waitFor("window.__jsonReleases.length === 1 && window.__jsonReleased === 0");
    // Rebuild the rows (minimal keeps the planner node): a new generation
    // hydrates from the snapshot and issues its own held answer.
    await page.evaluate("(() => { const s = document.getElementById('cp-pipeline'); s.value = 'minimal'; s.dispatchEvent(new Event('change')); })()");
    await page.waitFor("document.querySelectorAll('#createPanel .phaseRow').length === 4"
      + " && window.__releases.length === 2");
    // The OLD response finishes parsing now: stale after JSON. It must not
    // apply, clear the new request's state, or trigger a fetch.
    await page.evaluate("window.__jsonReleases[0]()");
    await waitNever(page, "[...document.getElementById('cp-model-planner').options].some((o) => o.value === 'openai-codex/gpt-old')"
      + " || window.__piFetches.length !== 2");
    assert.deepEqual(await page.evaluate(
      "[window.__jsonReleased, window.__fetchReleased]"), [1, 1],
      "the old JSON parsed once; the new request is still in flight");
    // Release the NEW answer (the JSON handle exists only after the fetch
    // settles): it fills the model list.
    await page.evaluate("(async () => { window.__releases[1]();"
      + " await new Promise((r) => setTimeout(r)); window.__jsonReleases[1](); })()");
    await waitOption(page, "cp-model-planner", "openai-codex/gpt-new-a");
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  });
});

test("settings round trip: failures stay visible and retry; a held success respects a manual edit; success is idempotent", async (t) => {
  await withFixture(t, (line) => {
    line.graph = loadBuiltinPipeline("default", fs, ROOT);
    line.nodeSettings = { planner: { harness: "pi", model: "openai-codex/gpt-5.2", effort: "high" } };
  }, async (holder, fx) => {
    const page = holder.page; await page.evaluate(failHoldSucceedPi);
    await clickTab(page, fx.lineId);
    await wait(page, `${PANE(fx.lineId)} && !${PANE(fx.lineId)}.hidden`);
    // First answer fails: error visible; the saved model keeps its raw id.
    await page.waitFor(["window.__piFetches.length >= 1",
      `${SEL("lp-browser-line", "authmode", "planner")}.value === 'openai-codex'`,
      `${PANE(fx.lineId)}.innerText.includes('pi detail exploded')`].join(" && "));
    assert.equal(await page.evaluate(`${SEL("lp-browser-line", "model", "planner")}.value`), "openai-codex/gpt-5.2");
    // Revert retries the still-failing answer.
    const before = await page.evaluate("window.__piFetches.length");
    await clickFormButton(page, fx.lineId, "Revert");
    await page.waitFor([`window.__piFetches.length > ${before}`,
      `${PANE(fx.lineId)}.innerText.includes('pi detail exploded')`].join(" && "));
    // The next success is held: the user edits the model; it must win.
    await clickFormButton(page, fx.lineId, "Revert");
    await page.waitFor("window.__releases.length === 1");
    assert.equal(await page.evaluate(`${SEL("lp-browser-line", "model", "planner")}.value`), "openai-codex/gpt-5.2");
    await changeSelect(page, "lp-browser-line", "model", "planner", "");
    await page.evaluate("(async () => { window.__releases[0]();"
      + " await new Promise((r) => setTimeout(r)); window.__jsonReleases[0](); })()");
    await waitOption(page, "lp-browser-line-model-planner", "openai-codex/gpt-5.2");
    assert.equal(await page.evaluate(`${SEL("lp-browser-line", "model", "planner")}.value`), "",
      "the manual edit wins over the late hydration");
    // A further Revert succeeds immediately; another one does not refetch.
    await clickFormButton(page, fx.lineId, "Revert");
    await page.waitFor([`${SEL("lp-browser-line", "model", "planner")}.selectedOptions[0].textContent === 'gpt-5.2'`,
      `${PANE(fx.lineId)}.innerText.includes('pi auth ok')`].join(" && "));
    const loaded = await page.evaluate("window.__piFetches.length");
    await clickFormButton(page, fx.lineId, "Revert");
    await waitNever(page, `window.__piFetches.length !== ${loaded}`
      + ` || ${SEL("lp-browser-line", "model", "planner")}.value !== 'openai-codex/gpt-5.2'`);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  });
});
