"use strict";
// Real-browser check of the settings round trip: creation selections reach
// the persisted nodeSettings and come back in Change settings; a no-op Save
// keeps the stored settings; late or failed answers cannot corrupt the
// form. Skipped when no Chrome is available.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startDashboardFixture } = require("./fixtures/dashboard-browser");
const { openPage } = require("./fixtures/browser-driver");
const { loadBuiltinPipeline } = require("../line-graph");

const ROOT = path.join(__dirname, "..");
// Line creation runs `git commit`: ignore this machine's global git config
// (a forced GPG sign would fail under the restricted PATH).
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

const PANE = (line) => `document.querySelector('.card[data-line-id="${line}"] .pipePane')`;
const SEL = (prefix, kind, node) => `document.getElementById('${prefix}-${kind}-${node}')`;
// Full observable state of one line's settings form (prefix "lp-<lineId>").
const STATE = (line) => { const p = "lp-" + line, S = (k, n) => SEL(p, k, n);
  return `(() => ({ harness: ${S("harness", "planner")}.value,
  mode: ${S("authmode", "planner")}.value, model: ${S("model", "planner")}.value,
  modeLabel: ${S("authmode", "planner")}.selectedOptions[0].textContent,
  modelLabel: ${S("model", "planner")}.selectedOptions[0].textContent,
  implMode: ${S("authmode", "backend-impl")}.value, implModel: ${S("model", "backend-impl")}.value,
  valMode: ${S("authmode", "backend-val")}.value, valModel: ${S("model", "backend-val")}.value,
  valModeLabel: ${S("authmode", "backend-val")}.selectedOptions[0].textContent,
  effort: ${S("effort", "planner")}.value, implEffort: ${S("effort", "backend-impl")}.value,
  maxCtx: ${S("maxctx", "planner")}.value }))()`; };

const STUBS = "window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };"
  + "window.marked = { use() {}, parse: (t) => String(t) };"
  + "window.__errs = []; window.__puts = []; window.__piFetches = []; window.__piInFlight = 0;"
  + "window.addEventListener('error', (e) => window.__errs.push(String(e.message)));"
  + "window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));"
  + "const __ce = console.error; console.error = (...a) => { window.__errs.push(a.join(' ')); __ce.apply(console, a); };"
  + "const __f = window.fetch; window.fetch = (url, opts) => {"
  + " const u = String(url); let p = __f.call(window, url, opts);"
  + " if (u.includes('/api/harnesses/pi')) { window.__piFetches.push(u); window.__piInFlight += 1;"
  + "  p = p.finally(() => { setTimeout(() => { window.__piInFlight -= 1; }, 0); }); }"
  + " if (opts && opts.method === 'PUT' && /\\/pipeline$/.test(u)) window.__puts.push({ url: u, body: opts.body });"
  + " return p; };";

// Saved settings under test: the real openai-codex provider id next to
// another provider, an unknown provider, and every field the form shows.
const NODE_SETTINGS = {
  planner: { harness: "pi", model: "openai-codex/gpt-5.2", effort: "high", maxContext: 200000, timeLimit: 1234 },
  "backend-impl": { harness: "pi", model: "anthropic/claude-x", effort: "low" },
  "backend-val": { harness: "pi", model: "unknownprov/model-9" },
};

const VIBE_SCRIPT = '#!/bin/sh\ncase "$1" in --version) echo "vibe 3.0.2"; exit 0;; esac\nexit 1\n';
const CODEX_SCRIPT = '#!/bin/sh\ncase "$1" in --version) echo "codex 1.0"; exit 0;; login) exit 0;; esac\nexit 1\n';
// Catalog with the openai-codex and anthropic providers; `pi auth check` ok.
const PI_SCRIPT = '#!/bin/sh\n'
  + 'case "$1" in\n'
  + '  --version) echo "pi 0.87"; exit 0;;\n'
  + '  --list-models) printf "provider model ctx\\nopenai-codex gpt-5.2 400000\\nopenai-codex gpt-5.1 400000\\nanthropic claude-x 200000\\n"; exit 0;;\n'
  + '  auth) exit 0;;\nesac\nexit 1\n';

// Fixture with fake CLIs, an optional line seed, and a ready page. The
// holder survives a run() that swaps the page (a fresh session).
async function withFixture(t, seed, run) {
  const fx = await startDashboardFixture();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "settings-roundtrip-bin-"));
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  for (const [name, text] of [["vibe", VIBE_SCRIPT], ["pi", PI_SCRIPT], ["codex", CODEX_SCRIPT]])
    fs.writeFileSync(path.join(bin, name), text, { mode: 0o755 });
  if (seed) seed(require("../server").lines.get(fx.lineId));
  const holder = { page: null };
  try {
    try { holder.page = await openPage(fx.url, { initScript: STUBS }); }
    catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + e.message);
      throw e;
    }
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

// The form fills in waves: tests wait for the expected final state, so a
// late apply cannot race the asserts.
const wait = (page, expr) => page.waitFor(expr, { timeoutMs: 10000 });
const waitOption = (page, id, value) => wait(page,
  `[...document.getElementById('${id}').options].some((o) => o.value === '${value}')`);
const waitSaved = (page, line) => page.waitFor(
  `/Saved\\. The settings apply from the next run\\./.test(${PANE(line)}.innerText)`);

// Hold every openai-codex detail answer; each held call pushes its release
// handle to window.__releases; call n answers with body n (last repeats).
const holdEachPiDetail = `(() => {
  window.__releases = []; window.__heldCalls = 0;
  const bodies = [[{ value: 'openai-codex/gpt-old', label: 'gpt-old' }],
    [{ value: 'openai-codex/gpt-new-a', label: 'gpt-new-a' },
     { value: 'openai-codex/gpt-new-b', label: 'gpt-new-b' }]];
  const real = window.fetch;
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('provider=openai-codex')) {
      const body = bodies[Math.min(window.__heldCalls++, bodies.length - 1)];
      window.__piFetches.push(u);
      return new Promise((r) => window.__releases.push(r)).then(() => new Response(
        JSON.stringify({ id: 'pi', authMode: 'openai-codex', auth: 'ok', models: body }),
        { status: 200 }));
    }
    return real(url, opts);
  };
})()`;

// Fail the first two openai-codex detail calls with HTTP 500, then succeed.
const failThenSucceedPi = `(() => {
  window.__piCalls = 0;
  const real = window.fetch;
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('provider=openai-codex')) {
      window.__piFetches.push(u);
      if (window.__piCalls++ < 2) return Promise.resolve(new Response(
        JSON.stringify({ error: 'pi detail exploded' }), { status: 500 }));
      return Promise.resolve(new Response(JSON.stringify({ id: 'pi',
        authMode: 'openai-codex', auth: 'ok', models: [
        { value: 'openai-codex/gpt-5.2', label: 'gpt-5.2' } ] }), { status: 200 })); }
    return real(url, opts);
  };
})()`;

test("settings round trip: creation selections reach nodeSettings and Change settings", async (t) => {
  await withFixture(t, null, async (holder, fx) => {
    let page = holder.page;
    // Create: pi + openai-codex on the planner, pi + anthropic on the
    // backend implementor; the other nodes keep their defaults.
    await page.evaluate("document.getElementById('create').click()");
    await page.waitFor("document.querySelectorAll('#createPanel .phaseRow').length === 6");
    await waitOption(page, "cp-harness-planner", "pi");
    await changeSelect(page, "cp", "harness", "planner", "pi");
    await changeSelect(page, "cp", "authmode", "planner", "openai-codex");
    await waitOption(page, "cp-model-planner", "openai-codex/gpt-5.2");
    await changeSelect(page, "cp", "model", "planner", "openai-codex/gpt-5.2");
    await changeSelect(page, "cp", "effort", "planner", "high");
    await changeSelect(page, "cp", "maxctx", "planner", "200K");
    await changeSelect(page, "cp", "harness", "backend-impl", "pi");
    await changeSelect(page, "cp", "authmode", "backend-impl", "anthropic");
    await waitOption(page, "cp-model-backend-impl", "anthropic/claude-x");
    await changeSelect(page, "cp", "model", "backend-impl", "anthropic/claude-x");
    await changeSelect(page, "cp", "effort", "backend-impl", "low");
    await page.evaluate("document.getElementById('cp-name').value = 'Round trip line'");
    await page.evaluate("[...document.querySelectorAll('#createPanel button')].find((b) => b.textContent === 'Create line').click()");
    await page.waitFor("[...document.querySelectorAll('.card')]"
      + ".some((c) => c.dataset.lineId !== 'browser-line')");

    // Persisted creation result: explicit overrides only, inherited
    // defaults absent, fresh-session nodes without maxContext.
    const listed = await (await fetch(`${fx.url}/api/lines`)).json();
    const created = listed.lines.find((l) => l.name === "Round trip line");
    assert.ok(created, "the created line is listed");
    const expected = {
      planner: { harness: "pi", model: "openai-codex/gpt-5.2", effort: "high", maxContext: 200000 },
      "backend-impl": { harness: "pi", model: "anthropic/claude-x", effort: "low" },
    };
    assert.deepEqual(created.nodeSettings, expected);
    // Seed the hidden timeLimit and an unknown provider via the settings
    // API; both must survive every later round trip.
    expected.planner.timeLimit = 1234;
    expected["backend-val"] = { harness: "pi", model: "unknownprov/model-9" };
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
    await wait(page, `${SEL(pre, "authmode", "planner")}.value === 'openai-codex'`);
    await wait(page, `${SEL(pre, "model", "planner")}.selectedOptions[0].textContent === 'gpt-5.2'`);
    await wait(page, `${SEL(pre, "authmode", "backend-impl")}.value === 'anthropic'`
      && `${SEL(pre, "authmode", "backend-val")}.value === 'unknownprov'`);
    const st = await page.evaluate(STATE(created.id));
    assert.equal(st.harness, "pi");
    assert.equal(st.model, "openai-codex/gpt-5.2");
    assert.equal(st.modelLabel, "gpt-5.2", "the catalog label replaces the raw id");
    assert.equal(st.effort, "high");
    assert.equal(st.maxCtx, "200K");
    assert.equal(st.implMode, "anthropic");
    assert.equal(st.implModel, "anthropic/claude-x");
    assert.equal(st.implEffort, "low");
    // A provider the catalog does not know stays selected, honestly labeled.
    assert.match(st.valModeLabel, /unknownprov \(not in catalog\)/);
    assert.equal(st.valModel, "unknownprov/model-9");
    // Inherited defaults show "default", not an invented selection.
    assert.equal(await page.evaluate(`${SEL(pre, "harness", "frontend-impl")}.value`), "");
    assert.equal(await page.evaluate(`${SEL(pre, "model", "frontend-impl")}.value`), "");
    assert.equal(await page.evaluate(`${SEL(pre, "effort", "frontend-impl")}.value`), "");
    // Fresh-session nodes have no max context control at all.
    assert.equal(await page.evaluate(`${SEL(pre, "maxctx", "backend-val")}`), null);
    assert.equal(await page.evaluate(`${SEL(pre, "maxctx", "integration")}`), null);

    // Revert: manual edits to the provider and effort are undone.
    await changeSelect(page, pre, "effort", "planner", "low");
    await changeSelect(page, pre, "authmode", "planner", "anthropic");
    await clickFormButton(page, created.id, "Revert");
    await wait(page, `${SEL(pre, "authmode", "planner")}.value === 'openai-codex'`);
    await wait(page, `${SEL(pre, "model", "planner")}.selectedOptions[0].textContent === 'gpt-5.2'`);
    await wait(page, `${SEL(pre, "effort", "planner")}.value === 'high'`);

    // No-op Save: the body keeps every field, including the hidden
    // timeLimit, and adds nothing for default nodes.
    await clickFormButton(page, created.id, "Save settings");
    await waitSaved(page, created.id);
    const puts = await page.evaluate("window.__puts");
    assert.equal(puts.length, 1);
    assert.deepEqual(JSON.parse(puts[0].body), { nodeSettings: expected });
    const after = await (await fetch(`${fx.url}/api/lines`)).json();
    assert.deepEqual(after.lines.find((l) => l.id === created.id).nodeSettings, expected);

    // Reopen (tab away and back): no refetch, values stay.
    const fetchesBefore = await page.evaluate("window.__piFetches.length");
    await clickTab(page, created.id, "Line");
    await clickTab(page, created.id);
    await page.evaluate("new Promise((r) => setTimeout(r, 400))");
    assert.equal(await page.evaluate("window.__piFetches.length"), fetchesBefore, "reopen does not refetch");
    assert.equal(await page.evaluate(`${SEL(pre, "model", "planner")}.value`), "openai-codex/gpt-5.2");
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  });
});

test("settings round trip: a rebuilt row rejects the old row's held answer; a manual edit wins", async (t) => {
  await withFixture(t, null, async (holder) => {
    const page = holder.page;
    await page.evaluate(holdEachPiDetail);
    // Create panel, default pipeline: pick pi + openai-codex on the planner.
    await page.evaluate("document.getElementById('create').click()");
    await page.waitFor("document.querySelectorAll('#createPanel .phaseRow').length === 6");
    await waitOption(page, "cp-harness-planner", "pi");
    await changeSelect(page, "cp", "harness", "planner", "pi");
    await changeSelect(page, "cp", "authmode", "planner", "openai-codex");
    await page.waitFor("window.__releases.length === 1");
    // Rebuild the rows (minimal keeps the planner node): a new row
    // generation hydrates from the snapshot and issues its own answer.
    await page.evaluate("(() => { const s = document.getElementById('cp-pipeline'); s.value = 'minimal'; s.dispatchEvent(new Event('change')); })()");
    await page.waitFor("document.querySelectorAll('#createPanel .phaseRow').length === 4");
    await page.waitFor("window.__releases.length === 2");
    // A manual model edit on the new row while its answer is in flight.
    await changeSelect(page, "cp", "model", "planner", "");
    // Release the NEW row's answer first; it fills the model list.
    await page.evaluate("window.__releases[1]()");
    await waitOption(page, "cp-model-planner", "openai-codex/gpt-new-a");
    // Release the OLD row's answer: it must be rejected, not applied, and it
    // must not overwrite the manual edit (the default stays selected).
    await page.evaluate("window.__releases[0]()");
    await page.evaluate("new Promise((r) => setTimeout(r, 300))");
    const options = await page.evaluate(
      "[...document.getElementById('cp-model-planner').options].map((o) => o.value)");
    assert.ok(options.includes("openai-codex/gpt-new-a"), "the new row's answer is applied");
    assert.ok(!options.includes("openai-codex/gpt-old"), "the old row's answer never wins");
    assert.equal(await page.evaluate(`${SEL("cp", "model", "planner")}.value`), "",
      "the old row's answer does not overwrite the manual edit");
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  });
});

test("settings round trip: a failed provider answer stays visible, retries, then succeeds idempotently", async (t) => {
  await withFixture(t, (line) => {
    line.graph = loadBuiltinPipeline("default", fs, ROOT);
    line.nodeSettings = { planner: { harness: "pi", model: "openai-codex/gpt-5.2", effort: "high" } };
  }, async (holder, fx) => {
    const page = holder.page;
    await page.evaluate(failThenSucceedPi);
    await clickTab(page, fx.lineId);
    await wait(page, `${PANE(fx.lineId)} && !${PANE(fx.lineId)}.hidden`);
    // First answer fails: the error stays visible, the saved model keeps
    // its raw id (never a silent default).
    await page.waitFor("window.__piFetches.length >= 1"
      && `${SEL("lp-browser-line", "authmode", "planner")}.value === 'openai-codex'`);
    await page.waitFor(`${PANE(fx.lineId)}.innerText.includes('pi detail exploded')`);
    assert.equal(await page.evaluate(`${SEL("lp-browser-line", "model", "planner")}.value`), "openai-codex/gpt-5.2");
    // Revert retries the still-failing answer.
    const before = await page.evaluate("window.__piFetches.length");
    await clickFormButton(page, fx.lineId, "Revert");
    await page.waitFor(`window.__piFetches.length > ${before}`);
    await page.waitFor(`${PANE(fx.lineId)}.innerText.includes('pi detail exploded')`);
    // The next retry succeeds: the catalog model replaces the raw id.
    await clickFormButton(page, fx.lineId, "Revert");
    await wait(page, `${SEL("lp-browser-line", "model", "planner")}.selectedOptions[0].textContent === 'gpt-5.2'`);
    await page.waitFor(`${PANE(fx.lineId)}.innerText.includes('pi auth ok')`);
    // A further Revert is idempotent: no new fetch, values stay.
    const loaded = await page.evaluate("window.__piFetches.length");
    await clickFormButton(page, fx.lineId, "Revert");
    await page.evaluate("new Promise((r) => setTimeout(r, 300))");
    assert.equal(await page.evaluate("window.__piFetches.length"), loaded, "no refetch after success");
    assert.equal(await page.evaluate(`${SEL("lp-browser-line", "model", "planner")}.value`), "openai-codex/gpt-5.2");
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  });
});
