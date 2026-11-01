"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { migratePresets, safeFileName } = require("../preset-migration");
const { loadBuiltinPipeline } = require("../line-graph");
const { buildCatalog } = require("../plugin-catalog");
const { resolvePipelineDefinition } = require("../resolve-pipeline");
const { startRouter, stopRouter } = require("./fixtures/router-process");

const ROOT = path.join(__dirname, "..");
const defaultText = fs.readFileSync(path.join(ROOT, "pipelines", "default.yaml"), "utf8");
const defaultGraph = loadBuiltinPipeline("default", fs, ROOT);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "preset-migration-"));

function setup(presets) {
  const lines = tmp();
  const presetsFile = path.join(lines, "pipeline-presets.json");
  if (presets) fs.writeFileSync(presetsFile, JSON.stringify(presets));
  return { lines, presetsFile, managedDir: path.join(lines, "plugins") };
}
function run(ctx, extra = {}) {
  const logs = [];
  const result = migratePresets({ presetsFile: ctx.presetsFile, managedDir: ctx.managedDir,
    defaultPipelineText: defaultText, defaultGraph, fs, log: (m) => logs.push(m),
    reservedNames: ["default", "minimal"], ...extra });
  return { result, logs };
}
const catalogOf = (ctx) => buildCatalog({ managedDir: ctx.managedDir, builtInDir: ROOT });
const files = (ctx) => {
  try { return fs.readdirSync(path.join(ctx.managedDir, "pipelines")).sort(); } catch { return []; }
};

const FAST = { planner: { harness: "claude", model: "opus" },
  implementor: { effort: "low", timeLimit: 600, maxContext: 50000 },
  validator: { model: "haiku" }, integration: { effort: "high" } };

test("two presets become two pipeline files with settings on the mapped nodes", () => {
  const ctx = setup([{ name: "Fast", pipeline: FAST, updatedAt: "x" },
    { name: "slow", pipeline: { planner: { model: "sonnet" } }, updatedAt: "y" }]);
  const { result, logs } = run(ctx);
  assert.deepEqual(result.migrated, [{ from: "Fast", to: "fast" }, { from: "slow", to: "slow" }]);
  assert.deepEqual(files(ctx), ["fast.yaml", "slow.yaml"]);
  assert.equal(fs.existsSync(ctx.presetsFile), false);
  assert.equal(fs.existsSync(`${ctx.presetsFile}.migrated`), true);
  assert.deepEqual(logs, ["preset migrated: 'Fast' -> 'fast'", "preset migrated: 'slow' -> 'slow'"]);

  const cat = catalogOf(ctx);
  assert.deepEqual(cat.problems, []);
  const fast = resolvePipelineDefinition("fast", cat);
  assert.equal(fast.name, "fast");
  assert.equal(fast.description, "Migrated from preset 'Fast'");
  assert.equal(fast.layer, "managed");
  assert.deepEqual(fast.nodes.planner.settings, { harness: "claude", model: "opus" });
  for (const id of ["backend-impl", "frontend-impl"]) {
    assert.deepEqual(fast.nodes[id].settings, { effort: "low", timeLimit: 600, maxContext: 50000 });
  }
  for (const id of ["backend-val", "frontend-val"]) assert.deepEqual(fast.nodes[id].settings, { model: "haiku" });
  assert.deepEqual(fast.nodes.integration.settings, { effort: "high" });
  // Same graph as the default otherwise.
  assert.deepEqual(fast.edges, defaultGraph.edges);
  assert.deepEqual(resolvePipelineDefinition("slow", cat).nodes["backend-impl"].settings, {});
});

test("names that collide get -2, -3, also with files and built-in names", () => {
  const ctx = setup([{ name: "My Preset", pipeline: { planner: { model: "a" } } },
    { name: "my preset!", pipeline: { planner: { model: "b" } } },
    { name: "my-preset", pipeline: { planner: { model: "c" } } },
    { name: "Default", pipeline: { planner: { model: "d" } } },
    { name: "taken", pipeline: { planner: { model: "e" } } }]);
  fs.mkdirSync(path.join(ctx.managedDir, "pipelines"), { recursive: true });
  fs.writeFileSync(path.join(ctx.managedDir, "pipelines", "taken.yaml"), "keep me");
  const { result } = run(ctx);
  assert.deepEqual(result.migrated.map((m) => m.to).sort(),
    ["default-2", "my-preset", "my-preset-2", "my-preset-3", "taken-2"]);
  assert.equal(fs.readFileSync(path.join(ctx.managedDir, "pipelines", "taken.yaml"), "utf8"), "keep me");
  const cat = catalogOf(ctx);
  assert.equal(resolvePipelineDefinition("taken-2", cat).nodes.planner.settings.model, "e");
});

test("unsafe names give safe file names; the old name stays in the description", () => {
  assert.equal(safeFileName("../../etc/passwd"), "etc-passwd");
  assert.equal(safeFileName("  "), "preset");
  assert.equal(safeFileName("A".repeat(80)).length, 60);
  assert.match(safeFileName("Ünï cödé"), /^[a-z0-9-]+$/);
  const ctx = setup([{ name: "../../evil name", pipeline: { planner: { model: "x" } } },
    { name: "x".repeat(60), pipeline: { planner: { model: "x" } } },
    { name: "x".repeat(60) + "", pipeline: { planner: { model: "y" } } }]);
  const { result } = run(ctx);
  assert.equal(result.migrated[0].to, "evil-name");
  for (const f of files(ctx)) assert.match(f, /^[a-z0-9-]{1,60}\.yaml$/);
  assert.deepEqual(fs.readdirSync(ctx.lines).sort(), ["pipeline-presets.json.migrated", "plugins"]);
  const cat = catalogOf(ctx);
  assert.equal(resolvePipelineDefinition("evil-name", cat).description, "Migrated from preset '../../evil name'");
});

test("an error rolls back: files removed, old file kept, error logged", () => {
  const ctx = setup([{ name: "one", pipeline: { planner: { model: "a" } } },
    { name: "two", pipeline: { planner: { model: "b" } } }]);
  const real = fs.renameSync;
  let renames = 0;
  const failing = Object.create(fs);
  failing.renameSync = (a, b) => {
    renames += 1;
    if (renames === 2) throw new Error("disk full");
    return real(a, b);
  };
  const { result, logs } = run(ctx, { fs: failing });
  assert.equal(result.error, "disk full");
  assert.deepEqual(files(ctx), []);
  assert.equal(fs.existsSync(ctx.presetsFile), true);
  assert.equal(fs.existsSync(`${ctx.presetsFile}.migrated`), false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /failed.*disk full/);
});

test("broken presets json: logged, nothing written, no throw", () => {
  const ctx = setup(null);
  fs.writeFileSync(ctx.presetsFile, "{not json");
  const { result, logs } = run(ctx);
  assert.ok(result.error);
  assert.equal(fs.existsSync(ctx.presetsFile), true);
  assert.equal(logs.length, 1);
});

test("a second boot does nothing; no presets file does nothing", () => {
  const none = setup(null);
  const first = run(none);
  assert.deepEqual(first.result.migrated, []);
  assert.deepEqual(first.logs, []);
  assert.equal(fs.existsSync(none.managedDir), false);

  const ctx = setup([{ name: "a", pipeline: { planner: { model: "a" } } }]);
  assert.equal(run(ctx).result.migrated.length, 1);
  const before = files(ctx);
  const again = run(ctx);
  assert.deepEqual(again.result.migrated, []);
  assert.deepEqual(again.logs, []);
  assert.deepEqual(files(ctx), before);
});

test("router: migrates at boot, serves the pipeline, old routes answer 410", async () => {
  const lines = tmp();
  fs.writeFileSync(path.join(lines, "pipeline-presets.json"), JSON.stringify([
    { name: "Fast One", pipeline: { implementor: { effort: "low" } }, updatedAt: "x" }]));
  const router = await startRouter(lines);
  try {
    assert.equal(fs.existsSync(path.join(lines, "pipeline-presets.json.migrated")), true);
    assert.equal(fs.existsSync(path.join(lines, "plugins", "pipelines", "fast-one.yaml")), true);
    for (const [method, url] of [["GET", "/api/pipeline-presets"], ["PUT", "/api/pipeline-presets/x"],
      ["DELETE", "/api/pipeline-presets/x"]]) {
      const res = await fetch(router.base + url, { method, headers: { "Content-Type": "application/json" },
        body: method === "PUT" ? "{}" : undefined });
      assert.equal(res.status, 410, `${method} ${url}`);
      const body = await res.json();
      assert.equal(body.use, "/api/pipelines");
      assert.ok(body.error);
    }
    const res = await fetch(router.base + "/api/lines", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "L", pipelineName: "fast-one" }) });
    assert.equal(res.status, 201, await res.clone().text());
  } finally {
    await stopRouter(router);
  }
});
