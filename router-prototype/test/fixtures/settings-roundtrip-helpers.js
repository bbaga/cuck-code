"use strict";
// Shared setup for the settings round-trip browser tests: a dashboard fixture
// with a fake pi CLI, a stubbed page, page helpers, and scriptable pi answers.
// Importing this module has no side effects: every environment override is
// scoped to the fixture run and restored afterwards.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startDashboardFixture } = require("./dashboard-browser");
const { openPage } = require("./browser-driver");

const PANE = (line) =>
  `document.querySelector('.card[data-line-id="${line}"] .pipePane')`;
const SEL = (prefix, kind, node) =>
  `document.getElementById('${prefix}-${kind}-${node}')`;

// Full observable state of one line's settings form (prefix "lp-<lineId>").
const STATE = (line) => {
  const p = "lp-" + line, S = (k, n) => SEL(p, k, n);
  return `(() => ({
    harness: ${S("harness", "planner")}.value, model: ${S("model", "planner")}.value,
    modelLabel: ${S("model", "planner")}.selectedOptions[0].textContent,
    effort: ${S("effort", "planner")}.value, maxCtx: ${S("maxctx", "planner")}.value,
    implMode: ${S("authmode", "backend-impl")}.value, implModel: ${S("model", "backend-impl")}.value,
    implEffort: ${S("effort", "backend-impl")}.value, valModel: ${S("model", "backend-val")}.value,
    valModeLabel: ${S("authmode", "backend-val")}.selectedOptions[0].textContent,
    bareMode: ${S("authmode", "frontend-impl")}.value, bareModel: ${S("model", "frontend-impl")}.value,
    intHarness: ${S("harness", "integration")}.value, intModel: ${S("model", "integration")}.value,
    valMaxCtx: ${S("maxctx", "backend-val")}, intMaxCtx: ${S("maxctx", "integration")},
  }))()`;
};

// Page stubs: capture errors and PUTs, count harness fetches, list pi calls.
const STUBS = `
  window.mermaid = { initialize() {}, run() { return Promise.resolve(); } };
  window.marked = { use() {}, parse: (t) => String(t) };
  window.__errs = []; window.__puts = []; window.__piFetches = [];
  window.addEventListener("error", (e) => window.__errs.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => window.__errs.push(String(e.reason)));
  const __ce = console.error;
  console.error = (...a) => { window.__errs.push(a.join(" ")); __ce.apply(console, a); };
  const __f = window.fetch;
  window.fetch = (url, opts) => {
    const u = String(url), p = __f.call(window, url, opts);
    if (u.includes("/api/harnesses")) p.finally(() => setTimeout(() => {
      window.__harnessDone = (window.__harnessDone || 0) + 1; }, 0));
    if (opts && opts.method === "PUT" && /\\/pipeline$/.test(u))
      window.__puts.push({ url: u, body: opts.body });
    return p;
  };
`;

// A fake pi CLI: two openai-codex models and one anthropic model.
const PI_SCRIPT = '#!/bin/sh\n'
  + 'case "$1" in --version) echo "pi 0.87"; exit 0;;\n'
  + '  --list-models) printf "provider model ctx\\nopenai-codex gpt-5.2 400000\\n'
  + 'openai-codex gpt-5.1 400000\\nanthropic claude-x 200000\\n"; exit 0;;\n'
  + '  auth) exit 0;; esac\nexit 1\n';

// Fixture with a fake pi CLI, an optional line seed, and a ready page; the
// holder survives a run() that swaps the page. opts.initScript replaces the
// default page stubs, opts.chromePath overrides the browser lookup, and the
// opts.pageClose/opts.fixtureClose seams wrap the two close steps (tests use
// them to prove cleanup independence). One outer guard covers every resource
// acquired after the dashboard starts: the finally block restores the
// environment (including the LINES_DIR the dashboard fixture rewrites),
// removes the temporary CLI directory, closes the page, and closes the
// fixture. Each attempt is independent; failures are collected and reported
// without masking the primary error.
async function withFixture(t, seed, run, opts = {}) {
  const oldEnv = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
    LINES_DIR: process.env.LINES_DIR,
  };
  const fx = await startDashboardFixture();
  const holder = { page: null };
  let bin = null;
  const cleanupErrors = [];
  const cleanup = async () => {
    process.env.PATH = oldEnv.PATH;
    for (const k of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "LINES_DIR"]) {
      if (oldEnv[k] === undefined) delete process.env[k];
      else process.env[k] = oldEnv[k];
    }
    if (bin) {
      try { fs.rmSync(bin, { recursive: true, force: true }); }
      catch (e) { cleanupErrors.push("temp CLI dir: " + e.message); }
    }
    try {
      if (holder.page) await (opts.pageClose || ((p) => p.close()))(holder.page);
    } catch (e) { cleanupErrors.push("page close: " + e.message); }
    try { await (opts.fixtureClose || (() => fx.close()))(); }
    catch (e) { cleanupErrors.push("fixture close: " + e.message); }
  };
  let failure = null;
  let skipMessage = null;
  try {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), "settings-roundtrip-bin-"));
    process.env.PATH = `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
    // Line creation runs `git commit`: ignore a global GPG-sign git config.
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    fs.writeFileSync(path.join(bin, "pi"), PI_SCRIPT, { mode: 0o755 });
    if (seed) seed(require("../../server").lines.get(fx.lineId));
    try {
      holder.page = await openPage(fx.url, {
        initScript: opts.initScript || STUBS,
        chromePath: opts.chromePath,
      });
    } catch (e) {
      if (e.code === "BROWSER_UNAVAILABLE") skipMessage = "Chrome is missing: " + e.message;
      else throw e;
    }
    if (!skipMessage) {
      await holder.page.setViewport(1100, 1100);
      await holder.page.waitFor("/browser[- ]line/i.test(document.body.innerText)");
      await run(holder, fx);
    }
  } catch (e) {
    failure = e;
  } finally {
    await cleanup();
  }
  if (failure) {
    if (cleanupErrors.length) {
      failure.message += " (fixture cleanup also failed: " + cleanupErrors.join("; ") + ")";
    }
    throw failure;
  }
  if (cleanupErrors.length) {
    throw new Error("fixture cleanup failed: " + cleanupErrors.join("; "));
  }
  if (skipMessage) return t.skip(skipMessage);
}

const clickTab = (page, line, name = "Pipeline") => page.evaluate(
  `[...document.querySelector('.card[data-line-id="${line}"]').querySelectorAll('button.tabBtn')]`
  + `.find((b) => b.textContent === '${name}').click()`);

const clickFormButton = (page, line, name) => page.evaluate(
  `[...${PANE(line)}.querySelectorAll('.pipeBtns button')]`
  + `.find((b) => b.textContent === '${name}').click()`);

const changeSelect = (page, prefix, kind, node, value) => page.evaluate(`(() => {
  const s = ${SEL(prefix, kind, node)};
  s.value = ${JSON.stringify(value)};
  s.dispatchEvent(new Event("change"));
})()`);

// Open the create panel and pick pi + openai-codex on the planner.
const openCreatePlannerPi = async (page) => {
  await page.evaluate(`document.getElementById("create").click()`);
  await page.waitFor(`document.querySelectorAll("#createPanel .phaseRow").length === 6`);
  await waitOption(page, "cp-harness-planner", "pi");
  await changeSelect(page, "cp", "harness", "planner", "pi");
  await changeSelect(page, "cp", "authmode", "planner", "openai-codex");
};

// The form fills in waves: tests wait for the expected final state, so a late
// apply cannot race; absence of a late effect is proven by bounded polling.
const wait = (page, expr) => page.waitFor(expr, { timeoutMs: 10000 });
const waitOption = (page, id, value) => wait(page,
  `[...document.getElementById('${id}').options].some((o) => o.value === '${value}')`);
const waitNever = async (page, badExpr, polls = 10) => {
  for (let i = 0; i < polls; i++) {
    const bad = await page.evaluate(badExpr);
    assert.ok(!bad, "the rejected effect appeared: " + badExpr);
    await page.evaluate("new Promise((r) => setTimeout(r, 50))");
  }
};

// A scriptable pi detail stub: call n answers with calls[n] (the last one
// repeats). One call is { hold, models, status, body }; a held call keeps
// the fetch in flight until released via a window.__releases handle.
const scriptedPi = (calls) => `
  window.__releases = []; window.__piCalls = 0;
  const __real = window.fetch;
  const __body = (m) => JSON.stringify(
    { id: "pi", authMode: "openai-codex", auth: "ok", models: m });
  window.fetch = (url, opts) => {
    const u = String(url);
    if (!u.includes("provider=openai-codex")) return __real(url, opts);
    window.__piFetches.push(u);
    const a = ${JSON.stringify(calls)}[Math.min(window.__piCalls++, ${calls.length - 1})];
    const res = new Response(a.body || __body(a.models), { status: a.status || 200 });
    return a.hold
      ? new Promise((resolve) => window.__releases.push(() => resolve(res)))
      : Promise.resolve(res);
  };
`;

// Call 0 is held with the old body, call 1 with the new bodies; later
// calls repeat the last held answer.
const holdOldThenNew = scriptedPi([
  { hold: true, models: [{ value: "openai-codex/gpt-old", label: "gpt-old" }] },
  { hold: true, models: [{ value: "openai-codex/gpt-new-a", label: "gpt-new-a" },
    { value: "openai-codex/gpt-new-b", label: "gpt-new-b" }] },
]);

// Two HTTP 500 failures, then a held success, then immediate successes.
const failHoldSucceedPi = scriptedPi([
  { status: 500, body: JSON.stringify({ error: "pi detail exploded" }) },
  { status: 500, body: JSON.stringify({ error: "pi detail exploded" }) },
  { hold: true, models: [{ value: "openai-codex/gpt-5.2", label: "gpt-5.2" }] },
  { models: [{ value: "openai-codex/gpt-5.2", label: "gpt-5.2" }] },
]);

module.exports = {
  withFixture, openPage, STUBS, PANE, SEL, STATE, clickTab, clickFormButton,
  changeSelect, openCreatePlannerPi, wait, waitOption, waitNever, scriptedPi,
  holdOldThenNew, failHoldSucceedPi,
};
