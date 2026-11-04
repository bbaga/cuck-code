"use strict";
// Real-browser check of the settings round trip: creation selections reach
// the persisted nodeSettings and return in Change settings; failed, late,
// and repeated hydrations respect the guards. Skips without Chrome.
const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("./fixtures/settings-roundtrip-helpers");

const { PANE, SEL, STATE, STUBS } = H;

test("settings round trip: creation selections reach nodeSettings and Change settings", async (t) => {
  await H.withFixture(t, null, async (holder, fx) => {
    let page = holder.page;

    // Create a line: pi + openai-codex on the planner, with effort and max
    // context; defaults elsewhere.
    await H.openCreatePlannerPi(page);
    await H.waitOption(page, "cp-model-planner", "openai-codex/gpt-5.2");
    await H.changeSelect(page, "cp", "model", "planner", "openai-codex/gpt-5.2");
    await H.changeSelect(page, "cp", "effort", "planner", "high");
    await H.changeSelect(page, "cp", "maxctx", "planner", "200K");
    await page.evaluate(`document.getElementById("cp-name").value = "Round trip line"`);
    await page.evaluate(`[...document.querySelectorAll("#createPanel button")].find((b) => b.textContent === "Create line").click()`);
    await page.waitFor(`[...document.querySelectorAll(".card")].some((c) => c.dataset.lineId !== "browser-line")`);

    // The persisted result lists explicit overrides only; fresh-session
    // nodes have no maxContext.
    const created = (await (await fetch(`${fx.url}/api/lines`)).json())
      .lines.find((l) => l.name === "Round trip line");
    assert.ok(created, "the created line is listed");
    const expected = {
      planner: { harness: "pi", model: "openai-codex/gpt-5.2", effort: "high", maxContext: 200000 },
    };
    assert.deepEqual(created.nodeSettings, expected);

    // Seed settings the form cannot express: timeLimit, an unknown provider,
    // and a bare model. All must survive the round trip.
    expected.planner.timeLimit = 1234;
    expected["backend-val"] = { harness: "pi", model: "unknownprov/model-9" };
    expected["frontend-impl"] = { harness: "pi", model: "gpt-5.2-bare" };
    const put = await fetch(`${fx.url}/api/lines/${created.id}/pipeline`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeSettings: expected }),
    });
    assert.equal(put.status, 200);

    // Fresh session: the scripted pi answers (two failures, then a held
    // success) install at document start, so the card's own hydration hits
    // them. Reopen the dashboard and the line's settings.
    await page.close();
    holder.page = page = await H.openPage(fx.url,
      { initScript: STUBS + H.failHoldSucceedPi });
    await page.waitFor("/Round trip line/i.test(document.body.innerText)");
    const line = created.id, pre = "lp-" + line;
    await H.clickTab(page, line);
    await H.wait(page, `${PANE(line)} && !${PANE(line)}.hidden`);

    // The first answer fails: the error stays visible, the model keeps its
    // raw id (never a silent default).
    await page.waitFor(`window.__piFetches.length >= 1`
      + ` && ${SEL(pre, "authmode", "planner")}.value === "openai-codex"`);
    await page.waitFor(`${PANE(line)}.innerText.includes("pi detail exploded")`);
    assert.equal(
      await page.evaluate(`${SEL(pre, "model", "planner")}.value`), "openai-codex/gpt-5.2");

    // Revert retries the still-failing answer.
    const before = await page.evaluate("window.__piFetches.length");
    await H.clickFormButton(page, line, "Revert");
    await page.waitFor(`window.__piFetches.length > ${before}`
      + ` && ${PANE(line)}.innerText.includes("pi detail exploded")`);

    // The next success is held: the user edits the model to the default,
    // and the late answer must respect that edit. It still applies its
    // models (the option appears), but the value stays edited.
    await H.clickFormButton(page, line, "Revert");
    await page.waitFor("window.__releases.length === 1");
    await H.changeSelect(page, pre, "model", "planner", "");
    await page.evaluate("window.__releases[0]()");
    await H.waitOption(page, `${pre}-model-planner`, "openai-codex/gpt-5.2");
    assert.equal(await page.evaluate(`${SEL(pre, "model", "planner")}.value`), "",
      "the manual edit wins over the late hydration");

    await H.clickFormButton(page, line, "Revert");
    await page.waitFor(`${PANE(line)}.innerText.includes("pi auth ok")`);

    // Every supported field is restored: the catalog label replaces the raw
    // id, the unknown provider stays honest, the bare model keeps its raw
    // value, defaults stay default, fresh-session nodes have no max ctx.
    await page.waitFor([
      `${SEL(pre, "authmode", "planner")}.value === "openai-codex"`,
      `${SEL(pre, "model", "planner")}.selectedOptions[0].textContent === "gpt-5.2"`,
      `${SEL(pre, "authmode", "backend-val")}.value === "unknownprov"`,
    ].join(" && "));
    assert.deepEqual(await page.evaluate(STATE(line)), {
      harness: "pi", model: "openai-codex/gpt-5.2", modelLabel: "gpt-5.2",
      effort: "high", maxCtx: "200K",
      implMode: "", implModel: "", implEffort: "",
      valModel: "unknownprov/model-9", valModeLabel: "unknownprov (not in catalog)",
      bareMode: "", bareModel: "gpt-5.2-bare",
      intHarness: "", intModel: "", valMaxCtx: null, intMaxCtx: null,
    });

    // A no-op Save keeps every stored field, timeLimit included, and adds
    // nothing for the default nodes.
    await H.clickFormButton(page, line, "Save settings");
    await page.waitFor(
      `/Saved\\. The settings apply from the next run\\./.test(${PANE(line)}.innerText)`);
    const puts = await page.evaluate("window.__puts");
    assert.equal(puts.length, 1);
    assert.deepEqual(JSON.parse(puts[0].body), { nodeSettings: expected });

    // Reopen (tab away and back): the catalog reloads, no refetch follows,
    // every value stays (hydration is idempotent).
    const [fetchesBefore, doneBefore] = await page.evaluate(
      "[window.__piFetches.length, window.__harnessDone || 0]");
    await H.clickTab(page, line, "Line");
    await H.clickTab(page, line);
    await page.waitFor(`(window.__harnessDone || 0) > ${doneBefore}`);
    await H.waitNever(page, `window.__piFetches.length !== ${fetchesBefore}`
      + ` || ${SEL(pre, "model", "planner")}.value !== "openai-codex/gpt-5.2"`
      + ` || ${SEL(pre, "model", "frontend-impl")}.value !== "gpt-5.2-bare"`);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  });
});

test("settings round trip: a superseded row answer cannot apply", async (t) => {
  await H.withFixture(t, null, async (holder) => {
    const page = holder.page;
    await page.evaluate(H.holdOldThenNew);

    await H.openCreatePlannerPi(page);
    await page.waitFor("window.__releases.length === 1");

    // Rebuild the rows (minimal keeps the planner node): the new generation
    // issues its own held request.
    await page.evaluate(`(() => {
      const s = document.getElementById("cp-pipeline");
      s.value = "minimal";
      s.dispatchEvent(new Event("change"));
    })()`);
    await page.waitFor(`document.querySelectorAll("#createPanel .phaseRow").length === 4`
      + ` && window.__releases.length === 2`);

    // The old answer resolves: stale. It must not apply, and no extra
    // fetch may follow.
    await page.evaluate("window.__releases[0]()");
    await H.waitNever(page,
      `[...document.getElementById("cp-model-planner").options]`
      + `.some((o) => o.value === "openai-codex/gpt-old")`
      + ` || window.__piFetches.length !== 2`);

    // The new answer resolves and applies: its model option appears.
    await page.evaluate("window.__releases[1]()");
    await H.waitOption(page, "cp-model-planner", "openai-codex/gpt-new-a");
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  });
});
