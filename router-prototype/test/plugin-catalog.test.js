"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildCatalog, defaultReadDir, defaultReadFile } = require("../plugin-catalog");
const { resolvePipelineDefinition, PipelineError } = require("../resolve-pipeline");
const { startRouter, stopRouter } = require("./fixtures/router-process");

const BUILT_IN = path.join(__dirname, "..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "plugin-catalog-"));
function put(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const nodeType = (name, extra = "") => `---\nname: ${name}\ndescription: A test type.\n${extra}---\nBody of ${name}.\n`;
const build = (dirs) => buildCatalog({ builtInDir: BUILT_IN, readDir: defaultReadDir, readFile: defaultReadFile, ...dirs });

// The built-in minimal pipeline with another name and the implementor type swapped.
const pipelineText = (name, implType = "implementor") =>
  fs.readFileSync(path.join(BUILT_IN, "pipelines", "minimal.yaml"), "utf8")
    .replace("name: minimal", `name: ${name}`).replace("type: implementor", `type: ${implType}`);

test("one entry per layer, each with its layer; built-in interactions have builtIn", () => {
  const managed = tmp(), user = tmp();
  put(managed, "node-types/m-type/NODE.md", nodeType("m-type", "extends: implementor\n"));
  put(user, "node-types/u-type/NODE.md", nodeType("u-type", "extends: implementor\n"));
  put(managed, "pipelines/m-pipe.yaml", pipelineText("m-pipe"));
  const c = build({ managedDir: managed, userDir: user });
  assert.equal(c.types["m-type"].layer, "managed");
  assert.equal(c.types["u-type"].layer, "user");
  assert.equal(c.types.implementor.layer, "built-in");
  assert.equal(c.pipelines["m-pipe"].layer, "managed");
  assert.equal(c.pipelines.default.layer, "built-in");
  assert.equal(c.interactions.report.layer, "built-in");
  assert.equal(c.interactions.report.builtIn, true);
  assert.deepEqual(c.problems, []);
  assert.deepEqual(c.shadowed, []);
  assert.equal(typeof c.readFile, "function");
});

test("a missing layer directory is not an error", () => {
  const c = build({ managedDir: path.join(tmp(), "nope"), userDir: path.join(tmp(), "nope") });
  assert.deepEqual(c.problems, []);
  assert.ok(c.pipelines.default);
});

test("the same name in two layers: the higher layer wins and the lower one is shadowed", () => {
  const managed = tmp(), user = tmp();
  put(managed, "node-types/dup/NODE.md", nodeType("dup", "extends: implementor\n"));
  put(user, "node-types/dup/NODE.md", nodeType("dup", "extends: implementor\n"));
  put(user, "pipelines/solo.yaml", pipelineText("solo"));
  const c = build({ managedDir: managed, userDir: user });
  assert.equal(c.types.dup.layer, "managed");
  assert.deepEqual(c.shadowed, [{ kind: "node-type", name: "dup", layer: "user", shadowedBy: "managed" }]);
  assert.equal(c.pipelines.solo.layer, "user");
});

test("a built-in name in the user layer is an error and the built-in one is kept", () => {
  const user = tmp();
  put(user, "node-types/planner/NODE.md", nodeType("planner"));
  put(user, "pipelines/default.yaml", pipelineText("default"));
  put(user, "interactions/report/INTERACTION.md", "---\nname: report\n---\nx\n");
  const c = build({ userDir: user });
  assert.equal(c.types.planner.layer, "built-in");
  assert.equal(c.pipelines.default.layer, "built-in");
  assert.equal(c.interactions.report.layer, "built-in");
  assert.equal(c.problems.length, 3);
  assert.ok(c.problems.every((p) => p.layer === "user" && /built-in name/.test(p.errors[0])));
  assert.deepEqual(c.shadowed, []);
});

test("a broken file goes to problems, stays out of the maps, and its pipeline fails at resolve time", () => {
  const user = tmp();
  put(user, "node-types/broken/NODE.md", "no frontmatter at all\n");
  put(user, "pipelines/uses-broken.yaml", pipelineText("uses-broken", "broken"));
  put(user, "pipelines/bad-yaml.yaml", "name: [unclosed\n");
  const c = build({ userDir: user });
  assert.equal(c.types.broken, undefined);
  assert.equal(c.pipelines["bad-yaml"], undefined);
  const paths = c.problems.map((p) => p.path);
  assert.ok(paths.includes(path.join(user, "node-types", "broken", "NODE.md")));
  assert.ok(paths.includes(path.join(user, "pipelines", "bad-yaml.yaml")));
  assert.ok(c.problems.every((p) => p.layer === "user" && Array.isArray(p.errors) && p.errors.length));
  assert.ok(c.pipelines["uses-broken"]);
  assert.throws(() => resolvePipelineDefinition("uses-broken", c), (e) => e instanceof PipelineError && /broken/.test(e.message));
});

test("a user node type may extend a built-in type and be used by a user pipeline", () => {
  const user = tmp();
  put(user, "node-types/careful-impl/NODE.md", nodeType("careful-impl", "extends: implementor\n"));
  put(user, "pipelines/careful.yaml", pipelineText("careful", "careful-impl"));
  const c = build({ userDir: user });
  assert.deepEqual(c.problems, []);
  const graph = resolvePipelineDefinition("careful", c);
  assert.equal(graph.name, "careful");
  assert.equal(graph.nodes.impl.type, "careful-impl");
  assert.equal(graph.types["careful-impl"].extends, "implementor");
});

test("the module reads folders only through the injected readDir", () => {
  const seen = [];
  const c = buildCatalog({ managedDir: "/m", userDir: "/u", builtInDir: "/b",
    readDir: (d) => { seen.push(d); const e = new Error("none"); e.code = "ENOENT"; throw e; },
    readFile: () => { throw new Error("no"); } });
  assert.equal(seen.length, 9);
  assert.deepEqual(c.problems, []);
  assert.deepEqual(c.pipelines, {});
});

test("router: POST /api/lines resolves pipelineName from the user layer", async () => {
  const root = tmp(), home = tmp();
  put(home, "pipelines/custom-flow.yaml", pipelineText("custom-flow"));
  put(home, "pipelines/broken-flow.yaml", pipelineText("broken-flow", "no-such-type"));
  const linesDir = path.join(root, "lines");
  fs.mkdirSync(linesDir);
  const router = await startRouter(linesDir, { CUCK_HOME: home });
  const post = async (body) => {
    const res = await fetch(router.base + "/api/lines", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    const ok = await post({ name: "Custom", pipelineName: "custom-flow" });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const saved = JSON.parse(fs.readFileSync(path.join(linesDir, ok.body.id, "line.json"), "utf8"));
    assert.equal(saved.graph.name, "custom-flow");
    const unknown = await post({ pipelineName: "nope" });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /custom-flow/);
    const broken = await post({ pipelineName: "broken-flow" });
    assert.equal(broken.status, 400);
    assert.match(broken.body.error, /no-such-type/);
    assert.ok(Array.isArray(broken.body.rules) && broken.body.rules.length);
  } finally {
    await stopRouter(router);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
