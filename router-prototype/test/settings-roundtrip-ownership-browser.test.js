"use strict";
// Real-browser ownership regressions for the Pi provider answer of one
// settings row. A request may only change its row while it is the current
// request. The page stub (heldPi) logs four separate moments per request:
// enter (fetch called), release (the test opened a hold), parsed (the real
// JSON parse finished), and done (a macrotask later, after the application's
// continuation ran). Each test waits for done, never for the release call and
// never for a stale effect to appear. Skips without Chrome.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadBuiltinPipeline } = require("../line-graph");
const H = require("./fixtures/settings-roundtrip-helpers");

const { PANE, SEL, STUBS } = H;
const ROOT = path.join(__dirname, "..");
const LINE = "browser-line";
const FORM = "lp-" + LINE;
const SAVED_MODEL = "openai-codex/gpt-5.2";
const SAVED_PLANNER = { planner: { harness: "pi", model: SAVED_MODEL } };

// Observable state of one row: the controls plus the auth hint line.
const ROW = (prefix, node) => `(() => {
  const model = ${SEL(prefix, "model", node)};
  return {
    harness: ${SEL(prefix, "harness", node)}.value,
    provider: ${SEL(prefix, "authmode", node)}.value,
    model: model.value,
    label: model.selectedOptions[0].textContent,
    options: [...model.options].map((o) => o.value),
    hint: model.parentElement.querySelector(".authHint").textContent,
  };
})()`;

const events = (page) => page.evaluate("window.__piEvents");
const fetchCount = (page) => page.evaluate("window.__piFetches.length");

// Seed the fixture line with a default graph and a saved Pi planner.
const seedSavedPlanner = (line) => {
  line.graph = loadBuiltinPipeline("default", fs, ROOT);
  line.nodeSettings = SAVED_PLANNER;
};

const initWith = (calls) => ({ initScript: STUBS + H.heldPi(calls) });

// Rebuild the create panel rows (minimal keeps the planner node). The new
// row generation hydrates from the old row and issues its own request.
const rebuildCreateRows = async (page) => {
  await page.evaluate(`(() => {
    const s = document.getElementById("cp-pipeline");
    s.value = "minimal";
    s.dispatchEvent(new Event("change"));
  })()`);
  await page.waitFor(`document.querySelectorAll("#createPanel .phaseRow").length === 4`);
};

const reopenChangeSettings = async (page) => {
  const done = await page.evaluate("window.__harnessDone || 0");
  await H.clickTab(page, LINE, "Line");
  await H.clickTab(page, LINE);
  await page.waitFor(`(window.__harnessDone || 0) > ${done}`);
};

test("ownership: a rebuilt row ignores the old row's parsed body", async (t) => {
  const calls = [
    { hold: "body", models: [{ value: "openai-codex/gpt-old", label: "gpt-old" }] },
    { hold: "fetch", models: [{ value: "openai-codex/gpt-new-a", label: "gpt-new-a" },
      { value: "openai-codex/gpt-new-b", label: "gpt-new-b" }] },
  ];
  await H.withFixture(t, null, async (holder) => {
    const page = holder.page;

    // Request A arrives and enters the JSON wrapper; its body stays held.
    await H.openCreatePlannerPi(page);
    await H.waitPiEvent(page, "json:0");

    // The rows rebuild: request B belongs to the new row and stays in flight.
    await rebuildCreateRows(page);
    await H.waitPiEvent(page, "enter:1");
    const before = await page.evaluate(ROW("cp", "planner"));
    assert.equal(before.provider, "openai-codex");
    assert.equal(before.model, "");
    assert.deepEqual(await events(page), ["enter:0", "json:0", "enter:1"]);

    // The release only opens the hold. The parse marker and the done marker
    // prove that the application consumed the stale body.
    await H.releasePi(page, 0);
    await H.waitPiEvent(page, "done:0");
    assert.deepEqual(await events(page),
      ["enter:0", "json:0", "enter:1", "release:0", "parsed:0", "done:0"]);

    // The stale body changed nothing: same controls, no stale model, no
    // success hint, and no extra request. B is still in flight.
    const after = await page.evaluate(ROW("cp", "planner"));
    assert.deepEqual(after, before);
    assert.ok(!after.options.includes("openai-codex/gpt-old"));
    assert.ok(!after.hint.includes("auth ok"));
    assert.equal(await fetchCount(page), 2);

    // B completes and applies: its models fill the list and the hint clears.
    await H.releasePi(page, 1);
    await H.waitPiEvent(page, "done:1");
    const final = await page.evaluate(ROW("cp", "planner"));
    assert.deepEqual(final.options, ["", "openai-codex/gpt-new-a", "openai-codex/gpt-new-b"]);
    assert.equal(final.model, "");
    assert.equal(final.provider, "openai-codex");
    assert.ok(final.hint.includes("pi auth ok"));
    assert.equal(await fetchCount(page), 2);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  }, initWith(calls));
});

test("ownership: a rebuilt row ignores the old row's fetch error", async (t) => {
  const calls = [
    { hold: "reject" },
    { hold: "fetch", models: [{ value: "openai-codex/gpt-new-a", label: "gpt-new-a" }] },
  ];
  await H.withFixture(t, null, async (holder) => {
    const page = holder.page;

    // Request A is in flight, then the rebuilt row starts request B.
    await H.openCreatePlannerPi(page);
    await H.waitPiEvent(page, "enter:0");
    await rebuildCreateRows(page);
    await H.waitPiEvent(page, "enter:1");
    const before = await page.evaluate(ROW("cp", "planner"));
    assert.equal(before.provider, "openai-codex");
    assert.deepEqual(await events(page), ["enter:0", "enter:1"]);

    // A's rejection reaches the application: the done marker follows it.
    await H.releasePi(page, 0);
    await H.waitPiEvent(page, "done:0");
    assert.deepEqual(await events(page), ["enter:0", "enter:1", "release:0", "done:0"]);

    // No stale error shows, B is still in flight, nothing was refetched.
    const after = await page.evaluate(ROW("cp", "planner"));
    assert.deepEqual(after, before);
    assert.ok(!after.hint.includes("network down"));
    assert.equal(await fetchCount(page), 2);

    // B completes: its models apply, the hint reports success, no error.
    await H.releasePi(page, 1);
    await H.waitPiEvent(page, "done:1");
    const final = await page.evaluate(ROW("cp", "planner"));
    assert.deepEqual(final.options, ["", "openai-codex/gpt-new-a"]);
    assert.ok(final.hint.includes("pi auth ok"));
    assert.ok(!final.hint.includes("network down"));
    assert.equal(await fetchCount(page), 2);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  }, initWith(calls));
});

test("ownership: a current fetch error stays visible and retries", async (t) => {
  const calls = [
    { hold: "reject" },
    { models: [{ value: SAVED_MODEL, label: "gpt-5.2" }] },
  ];
  await H.withFixture(t, seedSavedPlanner, async (holder) => {
    const page = holder.page;
    await H.clickTab(page, LINE);
    await H.waitPiEvent(page, "enter:0");

    // While the answer is in flight, the saved raw model id stays selected.
    const loading = await page.evaluate(ROW(FORM, "planner"));
    assert.equal(loading.provider, "openai-codex");
    assert.equal(loading.model, SAVED_MODEL);

    // The current request fails: the error shows, the saved model stays.
    await H.releasePi(page, 0);
    await H.waitPiEvent(page, "done:0");
    const failed = await page.evaluate(ROW(FORM, "planner"));
    assert.ok(failed.hint.includes("pi network down"));
    assert.equal(failed.model, SAVED_MODEL);
    assert.equal(failed.provider, "openai-codex");
    assert.equal(await fetchCount(page), 1);

    // Revert retries: one more request, the answer applies, the error goes.
    await H.clickFormButton(page, LINE, "Revert");
    await H.waitPiEvent(page, "done:1");
    const retried = await page.evaluate(ROW(FORM, "planner"));
    assert.ok(retried.hint.includes("pi auth ok"));
    assert.ok(!retried.hint.includes("network down"));
    assert.equal(retried.model, SAVED_MODEL);
    assert.equal(retried.label, "gpt-5.2");
    assert.equal(await fetchCount(page), 2);

    // A second Revert hydrates the same settings again: no new request. A
    // request would start synchronously, so the check is complete.
    await H.clickFormButton(page, LINE, "Revert");
    assert.equal(await fetchCount(page), 2);
    assert.deepEqual(await page.evaluate(ROW(FORM, "planner")), retried);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  }, initWith(calls));
});

test("ownership: a manual model edit wins over the late parsed body", async (t) => {
  const calls = [{ hold: "body", models: [{ value: SAVED_MODEL, label: "gpt-5.2" }] }];
  await H.withFixture(t, seedSavedPlanner, async (holder) => {
    const page = holder.page;
    await H.clickTab(page, LINE);
    await H.waitPiEvent(page, "json:0");

    // The user edits the model to the default while the body is held.
    await H.changeSelect(page, FORM, "model", "planner", "");
    assert.equal((await page.evaluate(ROW(FORM, "planner"))).model, "");

    // The late body parses and applies its models, but the edit stays.
    await H.releasePi(page, 0);
    await H.waitPiEvent(page, "done:0");
    assert.deepEqual(await events(page),
      ["enter:0", "json:0", "release:0", "parsed:0", "done:0"]);
    const edited = await page.evaluate(ROW(FORM, "planner"));
    assert.equal(edited.model, "", "the manual edit wins over the late hydration");
    assert.deepEqual(edited.options, ["", SAVED_MODEL]);
    assert.ok(edited.hint.includes("pi auth ok"));
    assert.equal(edited.provider, "openai-codex");

    // Reopening the form hydrates again: no request, the edit stays.
    await reopenChangeSettings(page);
    assert.equal(await fetchCount(page), 1);
    assert.deepEqual(await page.evaluate(ROW(FORM, "planner")), edited);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  }, initWith(calls));
});

// Same-row supersession in Change settings: request A is in flight, a manual
// edit plus Revert hydrates the row again, and request B replaces A. B's
// loading flag keeps the saved raw model visible. The stale completion of A
// must not change that, and a catalog refresh (reopening the tab) must not
// start a third request. Only a lost loading flag would start one.
async function checkSameRowSupersession(t, firstHold, entered, staleEvents) {
  const calls = [
    { hold: firstHold, models: [{ value: SAVED_MODEL, label: "stale-label" }] },
    { hold: "fetch", models: [{ value: SAVED_MODEL, label: "gpt-5.2" }] },
  ];
  await H.withFixture(t, seedSavedPlanner, async (holder) => {
    const page = holder.page;
    await H.clickTab(page, LINE);
    await H.waitPiEvent(page, entered);
    await H.changeSelect(page, FORM, "model", "planner", "");
    await H.clickFormButton(page, LINE, "Revert");
    await H.waitPiEvent(page, "enter:1");
    const before = await page.evaluate(ROW(FORM, "planner"));
    assert.equal(before.model, SAVED_MODEL, "B restores the saved raw model while it loads");
    assert.equal(before.provider, "openai-codex");
    assert.equal(await fetchCount(page), 2);

    // The stale completion of A: release, then the real completion marker.
    await H.releasePi(page, 0);
    await H.waitPiEvent(page, "done:0");
    assert.deepEqual((await events(page)).slice(-staleEvents.length), staleEvents);
    assert.deepEqual(await page.evaluate(ROW(FORM, "planner")), before);
    assert.ok(!before.hint.includes("network down"));
    assert.equal(await fetchCount(page), 2);

    // B still owns the loading flag: a catalog refresh starts nothing.
    await reopenChangeSettings(page);
    assert.equal(await fetchCount(page), 2, "the stale completion kept B's loading flag");
    assert.deepEqual(await page.evaluate(ROW(FORM, "planner")), before);

    // B completes: its label applies and the hint reports success.
    await H.releasePi(page, 1);
    await H.waitPiEvent(page, "done:1");
    const final = await page.evaluate(ROW(FORM, "planner"));
    assert.equal(final.model, SAVED_MODEL);
    assert.equal(final.label, "gpt-5.2");
    assert.ok(final.hint.includes("pi auth ok"));
    assert.equal(await fetchCount(page), 2);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  }, initWith(calls));
}

test("ownership: a same-row Revert keeps B's loading flag when A's parsed body arrives",
  (t) => checkSameRowSupersession(t, "body", "json:0",
    ["enter:1", "release:0", "parsed:0", "done:0"]));

test("ownership: a same-row Revert keeps B's loading flag when A's fetch error arrives",
  (t) => checkSameRowSupersession(t, "reject", "enter:0",
    ["enter:1", "release:0", "done:0"]));
