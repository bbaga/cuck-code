"use strict";

// External harness plugins: the loader, the catalog layer and the router.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadHarnessPluginFolder } = require("../harness-loader");
const { buildCatalog } = require("../plugin-catalog");
const { startRouter, stopRouter, wait } = require("./fixtures/router-process");

const FIXTURES = path.join(__dirname, "fixtures", "harness-plugins");
const FOLDERS = path.join(FIXTURES, "harnesses");
const BROKEN = ["syntax-error", "wrong-api-version", "claude", "mismatch", "no-resume", "factory-throws"];
const SDK = { apiVersion: 1 };

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const errorsFor = (id) => loadHarnessPluginFolder(path.join(FOLDERS, id), SDK).errors;

test("loader: good loads as a plugin", () => {
  const out = loadHarnessPluginFolder(path.join(FOLDERS, "good"), SDK);
  assert.equal(out.errors, undefined);
  assert.equal(out.plugin.id, "good");
});

test("loader: each broken fixture gives errors and never throws", () => {
  assert.match(errorsFor("syntax-error").join(), /cannot be loaded/);
  assert.match(errorsFor("wrong-api-version").join(), /apiVersion must be 1/);
  assert.match(errorsFor("claude").join(), /reserved/);
  assert.match(errorsFor("mismatch").join(), /must equal the folder name "mismatch"/);
  assert.match(errorsFor("no-resume").join(), /resumeSession must be a function/);
  assert.match(errorsFor("factory-throws").join(), /factory exploded/);
});

test("loader: a missing folder, a non-function export and a Promise are errors", () => {
  const dir = tempDir("loader-");
  try {
    assert.match(loadHarnessPluginFolder(path.join(dir, "absent"), SDK).errors[0], /cannot be loaded/);
    const notFn = path.join(dir, "not-fn");
    fs.mkdirSync(notFn);
    fs.writeFileSync(path.join(notFn, "index.js"), "module.exports = {};");
    assert.deepEqual(loadHarnessPluginFolder(notFn, SDK).errors, ["index.js must export a factory function"]);
    const async = path.join(dir, "async");
    fs.mkdirSync(async);
    fs.writeFileSync(path.join(async, "index.js"), "module.exports = async () => ({});");
    assert.match(loadHarnessPluginFolder(async, SDK).errors[0], /synchronously/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loader: a second load reads the new code", () => {
  const dir = tempDir("loader-");
  try {
    const folder = path.join(dir, "good");
    fs.cpSync(path.join(FOLDERS, "good"), folder, { recursive: true });
    assert.equal(loadHarnessPluginFolder(folder, SDK).plugin.displayName, "Good Echo");
    const file = path.join(folder, "index.js");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Good Echo", "Changed"));
    assert.equal(loadHarnessPluginFolder(folder, SDK).plugin.displayName, "Changed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog: good is a user harness; broken ones are problems", () => {
  const catalog = buildCatalog({ userDir: FIXTURES, harnessSdk: SDK });
  assert.deepEqual(Object.keys(catalog.harnesses), ["good"]);
  assert.equal(catalog.harnesses.good.layer, "user");
  assert.equal(catalog.harnesses.good.plugin.id, "good");
  const problems = catalog.problems.filter((p) => p.path.includes(path.sep + "harnesses" + path.sep));
  assert.deepEqual(problems.map((p) => path.basename(path.dirname(p.path))).sort(), [...BROKEN].sort());
  const reserved = problems.find((p) => p.path.includes(path.sep + "claude" + path.sep));
  assert.deepEqual(reserved.errors, ["harness 'claude' uses a built-in name"]);
});

test("catalog: the built-in layer adds no harness entry", () => {
  const catalog = buildCatalog({ builtInDir: path.join(__dirname, ".."), harnessSdk: SDK });
  assert.deepEqual(catalog.harnesses, {});
  assert.deepEqual(catalog.problems.filter((p) => p.path.includes(path.sep + "harnesses" + path.sep)), []);
});

test("catalog: without harnessSdk the harness kind does not run", () => {
  const catalog = buildCatalog({ userDir: FIXTURES });
  assert.deepEqual(catalog.harnesses, {});
  assert.deepEqual(catalog.problems, []);
});

const json = { "Content-Type": "application/json" };
const getHarnesses = async (base, query = "") => (await fetch(`${base}/api/harnesses${query}`)).json();

test("router: external harness listed, problems reported, reload and a run", { timeout: 60_000 }, async (t) => {
  const root = tempDir("harness-plugin-root-");
  const home = tempDir("harness-plugin-home-");
  fs.cpSync(FIXTURES, home, { recursive: true });
  const router = await startRouter(root, { CUCK_HOME: home });
  t.after(async () => {
    await stopRouter(router);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const { base } = router;

  const body = await getHarnesses(base, "?refresh=1");
  const good = body.harnesses.find((h) => h.id === "good");
  assert.equal(good.plugin.layer, "user");
  assert.equal(good.installed, true);
  assert.equal(good.displayName, "Good Echo");
  assert.deepEqual(body.harnesses.filter((h) => !h.plugin).map((h) => h.id), ["vibe", "pi", "codex", "claude"]);
  assert.equal(body.harnesses.some((h) => BROKEN.includes(h.id) && h.id !== "claude"), false);
  const broken = body.pluginProblems.map((p) => path.basename(path.dirname(p.path))).sort();
  assert.deepEqual(broken, [...BROKEN].sort());
  for (const p of body.pluginProblems) assert.ok(p.layer && p.errors.length);

  // A managed pipeline write calls rebuildCatalog, which reloads the plugin code.
  const file = path.join(home, "harnesses", "good", "index.js");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Good Echo", "Reloaded Echo"));
  const text = fs.readFileSync(path.join(__dirname, "..", "pipelines", "default.yaml"), "utf8")
    .replace(/^name:.*$/m, "name: reload-trigger");
  const put = await fetch(`${base}/api/pipelines/reload-trigger`, { method: "PUT", headers: json, body: JSON.stringify({ text }) });
  assert.ok(put.status === 200 || put.status === 201, `pipeline write status ${put.status}`);
  const reloaded = await getHarnesses(base, "?refresh=1");
  assert.equal(reloaded.harnesses.find((h) => h.id === "good").displayName, "Reloaded Echo");

  // A planner on the plugin harness completes its turn.
  const created = await fetch(`${base}/api/lines`, { method: "POST", headers: json,
    body: JSON.stringify({ name: "echo line", nodeSettings: { planner: { harness: "good" } } }) });
  assert.equal(created.status, 201);
  const line = await created.json();
  const prompt = await fetch(`${base}/api/lines/${line.id}/prompts`, { method: "POST", headers: json,
    body: JSON.stringify({ text: "make the plan" }) });
  assert.equal(prompt.status, 202);
  let status = "running";
  for (let i = 0; i < 200 && status === "running"; i++) {
    await wait(25);
    const current = (await (await fetch(`${base}/api/lines`)).json()).lines.find((l) => l.id === line.id);
    status = current.status;
  }
  assert.notEqual(status, "running");
  assert.notEqual(status, "failed");
});
