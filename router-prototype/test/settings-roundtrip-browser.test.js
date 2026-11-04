"use strict";
// Real-browser check of the settings round trip: creation selections reach
// the persisted nodeSettings and come back in Change settings, and the
// modified request guards hold. Skipped when no Chrome is available.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadBuiltinPipeline } = require("../line-graph");
const H = require("./fixtures/settings-roundtrip-helpers");

const ROOT = path.join(__dirname, "..");
const { PANE, SEL, STATE, STUBS } = H;

test("settings round trip: creation selections reach nodeSettings and Change settings", async (t) => {
  await H.withFixture(t, null, async (holder, fx) => {
    let page = holder.page;

    // Create a line: pi + openai-codex on the planner (with effort and max
    // context), pi + anthropic on the backend implementor. The other nodes
    // keep their defaults.
    await H.openCreatePlannerPi(page);
    await H.waitOption(page, "cp-model-planner", "openai-codex/gpt-5.2");
    await H.changeSelect(page, "cp", "model", "planner", "openai-codex/gpt-5.2");
    await H.changeSelect(page, "cp", "effort", "planner", "high");
    await H.changeSelect(page, "cp", "maxctx", "planner", "200K");
    await H.changeSelect(page, "cp", "harness", "backend-impl", "pi");
    await H.changeSelect(page, "cp", "authmode", "backend-impl", "anthropic");
    await H.waitOption(page, "cp-model-backend-impl", "anthropic/claude-x");
    await H.changeSelect(page, "cp", "model", "backend-impl", "anthropic/claude-x");
    await H.changeSelect(page, "cp", "effort", "backend-impl", "low");
    await page.evaluate(`document.getElementById("cp-name").value = "Round trip line"`);
    await page.evaluate(`[...document.querySelectorAll("#createPanel button")]
      .find((b) => b.textContent === "Create line").click()`);
    await page.waitFor(`[...document.querySelectorAll(".card")]
      .some((c) => c.dataset.lineId !== "browser-line")`);

    // The persisted creation result lists explicit overrides only: inherited
    // defaults are absent, and fresh-session nodes have no maxContext.
    const created = (await (await fetch(`${fx.url}/api/lines`)).json())
      .lines.find((l) => l.name === "Round trip line");
    assert.ok(created, "the created line is listed");
    const expected = {
      planner: { harness: "pi", model: "openai-codex/gpt-5.2", effort: "high", maxContext: 200000 },
      "backend-impl": { harness: "pi", model: "anthropic/claude-x", effort: "low" },
    };
    assert.deepEqual(created.nodeSettings, expected);

    // Seed settings the form cannot express: the hidden timeLimit, a
    // provider the catalog does not know, and a bare model without a
    // provider part. All must survive every round trip.
    expected.planner.timeLimit = 1234;
    expected["backend-val"] = { harness: "pi", model: "unknownprov/model-9" };
    expected["frontend-impl"] = { harness: "pi", model: "gpt-5.2-bare" };
    const put = await fetch(`${fx.url}/api/lines/${created.id}/pipeline`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeSettings: expected }),
    });
    assert.equal(put.status, 200);

    // Fresh session: reopen the dashboard and the new line's settings.
    await page.close();
    holder.page = page = await H.openPage(fx.url, { initScript: STUBS });
    await page.waitFor("/Round trip line/i.test(document.body.innerText)");
    await H.clickTab(page, created.id);
    await H.wait(page, `${PANE(created.id)} && !${PANE(created.id)}.hidden`);
    const pre = "lp-" + created.id;
    await H.waitAll(page, [
      `${SEL(pre, "authmode", "planner")}.value === "openai-codex"`,
      `${SEL(pre, "model", "planner")}.selectedOptions[0].textContent === "gpt-5.2"`,
      `${SEL(pre, "authmode", "backend-impl")}.value === "anthropic"`,
      `${SEL(pre, "authmode", "backend-val")}.value === "unknownprov"`,
    ]);

    // Every supported field is restored: the catalog label replaces the raw
    // id, an unknown provider stays selected and honestly labeled, a bare
    // model keeps its raw value with no guessed provider, inherited defaults
    // stay default, and fresh-session nodes have no max context control.
    assert.deepEqual(await page.evaluate(STATE(created.id)), {
      harness: "pi", model: "openai-codex/gpt-5.2", modelLabel: "gpt-5.2",
      effort: "high", maxCtx: "200K",
      implMode: "anthropic", implModel: "anthropic/claude-x", implEffort: "low",
      valModel: "unknownprov/model-9", valModeLabel: "unknownprov (not in catalog)",
      bareMode: "", bareModel: "gpt-5.2-bare",
      intHarness: "", intModel: "", valMaxCtx: null, intMaxCtx: null,
    });

    // A no-op Save keeps every stored field, including the hidden timeLimit
    // and the bare model, and adds nothing for the default nodes.
    await H.clickFormButton(page, created.id, "Save settings");
    await H.waitSaved(page, created.id);
    const puts = await page.evaluate("window.__puts");
    assert.equal(puts.length, 1);
    assert.deepEqual(JSON.parse(puts[0].body), { nodeSettings: expected });
    const after = await (await fetch(`${fx.url}/api/lines`)).json();
    assert.deepEqual(after.lines.find((l) => l.id === created.id).nodeSettings, expected);

    // Reopen (tab away and back): the catalog reload completes, no refetch
    // follows, and every value stays.
    const [fetchesBefore, doneBefore] = await page.evaluate(
      "[window.__piFetches.length, window.__harnessDone || 0]");
    await H.clickTab(page, created.id, "Line");
    await H.clickTab(page, created.id);
    await page.waitFor(`(window.__harnessDone || 0) > ${doneBefore}`);
    await H.waitNever(page, `window.__piFetches.length !== ${fetchesBefore}`
      + ` || ${SEL(pre, "model", "planner")}.value !== "openai-codex/gpt-5.2"`
      + ` || ${SEL(pre, "model", "frontend-impl")}.value !== "gpt-5.2-bare"`);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  });
});

test("settings round trip: a stale parsed answer cannot apply", async (t) => {
  await H.withFixture(t, null, async (holder) => {
    const page = holder.page;
    await page.evaluate(H.holdPiJsonThenNew);

    // Pick pi + openai-codex on the planner; its answer's JSON body is held.
    await H.openCreatePlannerPi(page);
    await page.waitFor("window.__jsonReleases.length === 1");

    // Rebuild the rows (minimal keeps the planner node): the new generation
    // issues its own request, whose JSON body is held too.
    await page.evaluate(`(() => {
      const s = document.getElementById("cp-pipeline");
      s.value = "minimal";
      s.dispatchEvent(new Event("change"));
    })()`);
    await page.waitFor(`document.querySelectorAll("#createPanel .phaseRow").length === 4`
      + ` && window.__jsonReleases.length === 2`);

    // The old answer parses now: stale, so it must not apply its model and
    // must not trigger an extra fetch.
    await page.evaluate("window.__jsonReleases[0]()");
    await H.waitNever(page,
      `[...document.getElementById("cp-model-planner").options]`
      + `.some((o) => o.value === "openai-codex/gpt-old")`
      + ` || window.__piFetches.length !== 2`);
    assert.equal(await page.evaluate("window.__jsonReleaseAck"), 1);

    // The new answer applies: its model option appears (parsing completed).
    await page.evaluate("window.__jsonReleases[1]()");
    await H.waitOption(page, "cp-model-planner", "openai-codex/gpt-new-a");
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  });
});

test("settings round trip: errors stay retryable, edits win, success is idempotent", async (t) => {
  await H.withFixture(t, (line) => {
    line.graph = loadBuiltinPipeline("default", fs, ROOT);
    line.nodeSettings = { planner: { harness: "pi", model: "openai-codex/gpt-5.2", effort: "high" } };
  }, async (holder, fx) => {
    const page = holder.page;
    const line = fx.lineId, pre = "lp-" + line;
    await page.evaluate(H.failHoldSucceedPi);
    await H.clickTab(page, line);
    await H.wait(page, `${PANE(line)} && !${PANE(line)}.hidden`);

    // The first answer fails: the error stays visible, and the saved model
    // keeps its raw id (never a silent default).
    await page.waitFor(`window.__piFetches.length >= 1`
      + ` && ${SEL(pre, "authmode", "planner")}.value === "openai-codex"`);
    await page.waitFor(`${PANE(line)}.innerText.includes("pi detail exploded")`);
    assert.equal(await page.evaluate(`${SEL(pre, "model", "planner")}.value`),
      "openai-codex/gpt-5.2");

    // Revert retries the still-failing answer.
    const before = await page.evaluate("window.__piFetches.length");
    await H.clickFormButton(page, line, "Revert");
    await page.waitFor(`window.__piFetches.length > ${before}`
      + ` && ${PANE(line)}.innerText.includes("pi detail exploded")`);

    // The next success is held: the user edits the model to the default, and
    // the late answer must respect that edit.
    await H.clickFormButton(page, line, "Revert");
    await page.waitFor("window.__jsonReleases.length === 1");
    await H.changeSelect(page, pre, "model", "planner", "");
    await page.evaluate("window.__jsonReleases[0]()");
    await H.waitOption(page, `${pre}-model-planner`, "openai-codex/gpt-5.2");
    assert.equal(await page.evaluate(`${SEL(pre, "model", "planner")}.value`), "",
      "the manual edit wins over the late hydration");

    // A further Revert succeeds immediately; another one does not refetch.
    await H.clickFormButton(page, line, "Revert");
    await page.waitFor(`${PANE(line)}.innerText.includes("pi auth ok")`);
    const loaded = await page.evaluate("window.__piFetches.length");
    await H.clickFormButton(page, line, "Revert");
    await H.waitNever(page, `window.__piFetches.length !== ${loaded}`
      + ` || ${SEL(pre, "model", "planner")}.value !== "openai-codex/gpt-5.2"`);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  });
});
