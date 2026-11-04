"use strict";
// Real-browser check of the settings round trip: creation selections reach
// the persisted nodeSettings and return in Change settings; both known
// catalog providers restore; a non-Pi row round-trips in isolation; the
// saved state is proven on the server and on disk after a real Save; an
// intentional same-row harness change clears the Pi state; and failed,
// late, and repeated hydrations respect the guards. The openai-codex
// answers are scripted; the anthropic answers come from the live fixture
// catalog, so both paths are proven. Skips without Chrome.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const server = require("../server");
const H = require("./fixtures/settings-roundtrip-helpers");

const { PANE, SEL, STATE, STUBS } = H;

// A test-side fetch-boundary observer for the scripted pi request: it marks
// the real settlement of the returned promise, in a macrotask after the
// settled promise reached the application. It proves delivery, not release.
const SETTLED_PI = `
  window.__settledPi = 0;
  const __sf = window.fetch;
  window.fetch = (url, opts) => {
    const p = __sf(url, opts);
    if (String(url).includes("provider=openai-codex")) Promise.resolve(p).catch(() => {})
      .then(() => setTimeout(() => { window.__settledPi += 1; }, 0));
    return p;
  };
`;

// The install gate re-probes the fake CLI on every request. Under heavy
// parallel browser load one probe can exceed its 2 s timeout, and the gate
// then wrongly reports the harness as missing. Retry only that error.
async function seedLine(fx, nodeSettings) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${fx.url}/api/lines`, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Harness switch line", pipelineName: "default", nodeSettings }) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 201 || !/not installed/.test(data.error || "")) return res;
  }
  throw new Error("the line seed kept failing with 'not installed'");
}

test("settings round trip: creation selections reach nodeSettings and Change settings", async (t) => {
  await H.withFixture(t, null, async (holder, fx) => {
    let page = holder.page;

    // The fixture ships only a fake pi CLI. A minimal fake vibe CLI makes
    // the default non-Pi harness installed too, so a vibe row can be
    // seeded, gated, and hydrated like a real one.
    const binDir = process.env.PATH.split(":")[0];
    fs.writeFileSync(path.join(binDir, "vibe"), '#!/bin/sh\necho "vibe 1.2.3"\n',
      { mode: 0o755 });

    // Create a line: pi + openai-codex on the planner (scripted later, live
    // here), pi + anthropic on the backend implementor (live catalog).
    await H.openCreatePlannerPi(page);
    await H.waitOption(page, "cp-model-planner", "openai-codex/gpt-5.2");
    await H.changeSelect(page, "cp", "model", "planner", "openai-codex/gpt-5.2");
    await H.changeSelect(page, "cp", "effort", "planner", "high");
    await H.changeSelect(page, "cp", "maxctx", "planner", "200K");
    await H.changeSelect(page, "cp", "harness", "backend-impl", "pi");
    await H.waitOption(page, "cp-authmode-backend-impl", "anthropic");
    await H.changeSelect(page, "cp", "authmode", "backend-impl", "anthropic");
    await H.waitOption(page, "cp-model-backend-impl", "anthropic/claude-x");
    await H.changeSelect(page, "cp", "model", "backend-impl", "anthropic/claude-x");
    await H.changeSelect(page, "cp", "effort", "backend-impl", "low");
    await page.evaluate(`document.getElementById("cp-name").value = "Round trip line"`);
    await page.evaluate(`[...document.querySelectorAll("#createPanel button")].find((b) => b.textContent === "Create line").click()`);
    await page.waitFor(`[...document.querySelectorAll(".card")].some((c) => c.dataset.lineId !== "browser-line")`);

    // The persisted result lists explicit overrides only; untouched nodes
    // inherit the defaults.
    const created = (await (await fetch(`${fx.url}/api/lines`)).json())
      .lines.find((l) => l.name === "Round trip line");
    assert.ok(created, "the created line is listed");
    const expected = {
      planner: { harness: "pi", model: "openai-codex/gpt-5.2", effort: "high", maxContext: 200000 },
      "backend-impl": { harness: "pi", model: "anthropic/claude-x", effort: "low" },
    };
    assert.deepEqual(created.nodeSettings, expected);

    // Seed settings the form cannot express: a hidden timeLimit, an unknown
    // provider, a bare model, and a non-Pi vibe row. All must survive.
    expected.planner.timeLimit = 1234;
    expected["backend-val"] = { harness: "pi", model: "unknownprov/model-9" };
    expected["frontend-impl"] = { harness: "pi", model: "gpt-5.2-bare" };
    expected.integration = { harness: "vibe", model: "glm-5-3-flash", effort: "low" };
    const put = await fetch(`${fx.url}/api/lines/${created.id}/pipeline`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeSettings: expected }),
    });
    assert.equal(put.status, 200);

    // Fresh session: the scripted pi answers (two failures, then a held
    // success) hit the card's own hydration. Reopen the dashboard.
    await page.close();
    holder.page = page = await H.openPage(fx.url,
      { initScript: STUBS + H.failHoldSucceedPi });
    await page.waitFor("/Round trip line/i.test(document.body.innerText)");
    const line = created.id, pre = "lp-" + line;
    await H.clickTab(page, line);
    await H.wait(page, `${PANE(line)} && !${PANE(line)}.hidden`);

    // The first answer fails: the error stays visible, the model keeps its
    // raw id (never a silent default), and the provider stays selected.
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
    // id, the second known provider comes back from the live catalog, the
    // unknown provider stays honest, the bare model keeps its raw value,
    // the non-Pi row keeps its own harness and model, defaults stay default.
    await page.waitFor([
      `${SEL(pre, "authmode", "planner")}.value === "openai-codex"`,
      `${SEL(pre, "model", "planner")}.selectedOptions[0].textContent === "gpt-5.2"`,
      `${SEL(pre, "authmode", "backend-impl")}.value === "anthropic"`,
      `${SEL(pre, "model", "backend-impl")}.value === "anthropic/claude-x"`,
      `${SEL(pre, "authmode", "backend-val")}.value === "unknownprov"`,
    ].join(" && "));
    assert.deepEqual(await page.evaluate(STATE(line)), {
      harness: "pi", model: "openai-codex/gpt-5.2", modelLabel: "gpt-5.2",
      effort: "high", maxCtx: "200K",
      implMode: "anthropic", implModel: "anthropic/claude-x", implEffort: "low",
      valModel: "unknownprov/model-9", valModeLabel: "unknownprov (not in catalog)",
      bareMode: "", bareModel: "gpt-5.2-bare",
      intHarness: "vibe", intModel: "glm-5-3-flash", valMaxCtx: null, intMaxCtx: null,
    });
    assert.equal(await page.evaluate(`${SEL(pre, "effort", "integration")}.value`), "low");
    assert.equal(await page.evaluate(`${SEL(pre, "harness", "frontend-val")}.value`), "",
      "an inherited node stays on the defaults");

    // Pi-to-non-Pi isolation: editing and reverting the vibe row restores
    // it without touching the Pi rows, and no Pi refetch follows.
    const piFetchesBefore = await page.evaluate("window.__piFetches.length");
    await H.changeSelect(page, pre, "model", "integration", "glm-5-3");
    await H.clickFormButton(page, line, "Revert");
    await H.wait(page, `${SEL(pre, "model", "integration")}.value === "glm-5-3-flash"`);
    assert.equal(await page.evaluate(`${SEL(pre, "model", "planner")}.value`),
      "openai-codex/gpt-5.2", "the Pi row is untouched by the vibe revert");
    assert.equal(await page.evaluate("window.__piFetches.length"), piFetchesBefore,
      "the vibe revert triggers no Pi refetch");

    // A no-op Save keeps every stored field, timeLimit included, and adds
    // nothing for the default nodes. The message appears only after the
    // real PUT response applied.
    await H.clickFormButton(page, line, "Save settings");
    await page.waitFor(
      `/Saved\\. The settings apply from the next run\\./.test(${PANE(line)}.innerText)`);
    const puts = await page.evaluate("window.__puts");
    assert.equal(puts.length, 1);
    assert.deepEqual(JSON.parse(puts[0].body), { nodeSettings: expected });

    // Independent proof beyond the captured PUT body: GET the line (the
    // server's stored state) and read line.json (the disk file written
    // through saveLine). Both must carry the same overrides, timeLimit too.
    const stored = (await (await fetch(`${fx.url}/api/lines`)).json())
      .lines.find((l) => l.id === line);
    assert.deepEqual(stored.nodeSettings, expected);
    const savedLine = [...server.lines.values()].find((l) => l.id === line);
    assert.ok(savedLine, "the created line is registered");
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(savedLine.workdir, "line.json"), "utf8"));
    assert.deepEqual(onDisk.nodeSettings, expected,
      "the overrides reached the disk file, timeLimit included");

    // Reopen (tab away and back): the catalog reloads, no refetch follows,
    // every value stays (hydration is idempotent).
    const [fetchesBefore, doneBefore] = await page.evaluate(
      "[window.__piFetches.length, window.__harnessDone || 0]");
    await H.clickTab(page, line, "Line");
    await H.clickTab(page, line);
    await page.waitFor(`(window.__harnessDone || 0) > ${doneBefore}`);
    await H.waitNever(page, `window.__piFetches.length !== ${fetchesBefore}`
      + ` || ${SEL(pre, "model", "planner")}.value !== "openai-codex/gpt-5.2"`
      + ` || ${SEL(pre, "model", "backend-impl")}.value !== "anthropic/claude-x"`
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

test("settings round trip: an intentional harness change clears the Pi state on the same row", async (t) => {
  await H.withFixture(t, null, async (holder, fx) => {
    let page = holder.page;

    // The same minimal fake vibe CLI as above, so vibe counts as installed.
    const binDir = process.env.PATH.split(":")[0];
    fs.writeFileSync(path.join(binDir, "vibe"), '#!/bin/sh\necho "vibe 1.2.3"\n',
      { mode: 0o755 });

    // Seed a line: the planner on pi + openai-codex with effort, max
    // context, and the hidden timeLimit; the backend implementor on the
    // second known provider, to prove the switch keeps unrelated overrides.
    const post = await seedLine(fx, {
      planner: { harness: "pi", model: "openai-codex/gpt-5.2",
        effort: "high", maxContext: 200000, timeLimit: 1234 },
      "backend-impl": { harness: "pi", model: "anthropic/claude-x", effort: "low" },
    });
    assert.equal(post.status, 201);
    const created = (await (await fetch(`${fx.url}/api/lines`)).json())
      .lines.find((l) => l.name === "Harness switch line");
    const line = created.id, pre = "lp-" + line;

    // Fresh session: the planner's pi detail answer is held in flight.
    await page.close();
    holder.page = page = await H.openPage(fx.url,
      { initScript: STUBS + H.scriptedPi([{ hold: true,
        models: [{ value: "openai-codex/gpt-5.2", label: "gpt-5.2" }] }]) + SETTLED_PI });
    await page.waitFor("/Harness switch line/i.test(document.body.innerText)");
    await H.clickTab(page, line);
    await H.wait(page, `${PANE(line)} && !${PANE(line)}.hidden`);
    await page.waitFor(`window.__releases.length === 1`
      + ` && ${SEL(pre, "authmode", "planner")}.value === "openai-codex"`);

    // The user switches the same row to vibe, while the answer is in flight.
    await H.changeSelect(page, pre, "harness", "planner", "vibe");

    // The switch clears the incompatible Pi state at once: the provider
    // select is hidden and empty, the model drops to the empty default, and
    // only vibe model choices remain (no qualified Pi id).
    await H.wait(page, `${SEL(pre, "harness", "planner")}.value === "vibe"`
      + ` && ${SEL(pre, "authmode", "planner")}.hidden`
      + ` && ${SEL(pre, "authmode", "planner")}.value === ""`
      + ` && ${SEL(pre, "model", "planner")}.value === ""`);
    assert.equal(await page.evaluate(
      `[...${SEL(pre, "model", "planner")}.options].some((o) => o.value.includes("/"))`),
      false, "no Pi qualified model survives the switch");

    // Await the settlement marker of that exact fetch, not the release
    // call: the assertions below observe the row after delivery to the app.
    await page.evaluate("window.__releases[0]()");
    await page.waitFor("window.__settledPi >= 1");
    await H.waitNever(page, `${SEL(pre, "model", "planner")}.value !== ""`
      + ` || ${SEL(pre, "harness", "planner")}.value !== "vibe"`
      + ` || !${SEL(pre, "authmode", "planner")}.hidden`
      + ` || [...${SEL(pre, "model", "planner")}.options].some((o) => o.value.includes("/"))`);

    // The user picks a vibe model and saves. Effort, max context, and the
    // hidden timeLimit survive the harness change; no Pi value and no
    // authMode field reach the payload; the other row keeps its overrides.
    await H.waitOption(page, `${pre}-model-planner`, "glm-5-3-flash");
    await H.changeSelect(page, pre, "model", "planner", "glm-5-3-flash");
    await H.clickFormButton(page, line, "Save settings");
    await page.waitFor(
      `/Saved\\. The settings apply from the next run\\./.test(${PANE(line)}.innerText)`);
    const expectedSwitched = {
      planner: { harness: "vibe", model: "glm-5-3-flash", effort: "high",
        maxContext: 200000, timeLimit: 1234 },
      "backend-impl": { harness: "pi", model: "anthropic/claude-x", effort: "low" },
    };
    const puts = await page.evaluate("window.__puts");
    assert.equal(puts.length, 1);
    assert.deepEqual(JSON.parse(puts[0].body), { nodeSettings: expectedSwitched });

    // The same map is proven on the server and on the disk file.
    const stored = (await (await fetch(`${fx.url}/api/lines`)).json())
      .lines.find((l) => l.id === line);
    assert.deepEqual(stored.nodeSettings, expectedSwitched);
    const savedLine = [...server.lines.values()].find((l) => l.id === line);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(savedLine.workdir, "line.json"), "utf8"));
    assert.deepEqual(onDisk.nodeSettings, expectedSwitched);
    assert.deepEqual(await page.evaluate("window.__errs"), []);
  });
});
