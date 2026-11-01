"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const api = require("../pipelines-api");
const { buildCatalog } = require("../plugin-catalog");
const { resolvePipelineDefinition } = require("../resolve-pipeline");
const { startRouter, stopRouter } = require("./fixtures/router-process");

const ROOT = path.join(__dirname, "..");
const defaultText = fs.readFileSync(path.join(ROOT, "pipelines", "default.yaml"), "utf8");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pipelines-api-"));

// ---- pure helpers ----

test("name rules", () => {
  for (const ok of ["a", "default", "a-b-1", "0x", "x".repeat(60)]) assert.equal(api.nameError(ok), null, ok);
  for (const bad of ["", "-a", "A", "a_b", "a.b", "a/b", "../x", "..", "x".repeat(61), "a b", null, 5, "a%2Fb", "a\\b"]) {
    assert.ok(api.nameError(bad), String(bad));
  }
});

test("text rules: type and 256 KB", () => {
  assert.deepEqual(api.textError("x".repeat(256 * 1024)), null);
  assert.equal(api.textError("x".repeat(256 * 1024 + 1)).status, 413);
  assert.equal(api.textError("é".repeat(140000)).status, 413); // bytes, not characters
  assert.equal(api.textError(5).status, 400);
  assert.equal(api.textError(undefined).status, 400);
});

function catalog(managedDir) {
  return buildCatalog({ managedDir, builtInDir: ROOT, userDir: path.join(managedDir, "no-user") });
}

test("validateText: valid, parse error, rule error, name errors", () => {
  const managedDir = tmp();
  const cat = catalog(managedDir);
  const ctx = { catalog: cat, managedDir, builtInNames: ["default", "minimal"] };
  const copy = defaultText.replace("name: default", "name: mine");
  const ok = api.validateText({ ...ctx, text: copy, expectName: "mine" });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.resolved.name, "mine");
  assert.equal(ok.resolved.layer, "managed");

  const parse = api.validateText({ ...ctx, text: "name: [", expectName: "mine" });
  assert.equal(parse.errors[0].rule, "LOAD");
  assert.equal(parse.resolved, null);

  const rule = api.validateText({ ...ctx, text: copy.replace("start: planner", "start: backend-val"), expectName: "mine" });
  assert.ok(rule.errors.length && rule.errors.every((e) => e.rule && e.message));
  assert.ok(!rule.errors.some((e) => e.rule === "LOAD"));

  const mismatch = api.validateText({ ...ctx, text: copy, expectName: "other" });
  assert.equal(mismatch.errors[0].rule, "NAME");
  assert.match(mismatch.errors[0].message, /must equal 'other'/);

  const builtIn = api.validateText({ ...ctx, text: defaultText });
  assert.equal(builtIn.errors[0].rule, "NAME");
  assert.match(builtIn.errors[0].message, /built-in/);

  const badName = api.validateText({ ...ctx, text: copy.replace("name: mine", "name: ../evil") });
  assert.equal(badName.errors[0].rule, "NAME");
});

test("graphPreview, listing, rename and the managed writer", () => {
  const managedDir = tmp();
  const cat = catalog(managedDir);
  const resolved = resolvePipelineDefinition("default", cat);
  const g = api.graphPreview(resolved);
  assert.deepEqual(g.nodes[0], { id: "planner", type: "planner", phase: "planner" });
  assert.ok(g.nodes.find((n) => n.id === "backend-impl" && n.phase === "implementor"));
  assert.deepEqual(g.edges.find((e) => e.from === "integration"), { from: "integration", to: "planner", interactions: ["report"] });
  assert.equal(api.graphPreview(null), null);

  const list = api.buildListing(cat, (n) => resolvePipelineDefinition(n, cat));
  const def = list.pipelines.find((p) => p.name === "default");
  assert.deepEqual(Object.keys(def).sort(), ["description", "editable", "layer", "name", "problems"]);
  assert.equal(def.editable, false);
  assert.equal(def.layer, "built-in");
  assert.ok(list.nodeTypes.some((t) => t.name === "planner"));
  assert.ok(list.interactions.some((i) => i.name === "report"));

  const renamed = api.renameInText(defaultText, "copy");
  assert.match(renamed, /^name: copy$/m);
  assert.equal(renamed, defaultText.replace("name: default", "name: copy"));
  assert.equal(api.renameInText("name: a # c\nstart: x\n", "b"), "name: b # c\nstart: x\n");
  assert.match(renamed, /backend-impl/);

  const write = (file, text) => fs.writeFileSync(file, text);
  const w = api.writeManagedPipeline({ fs, managedDir, name: "copy", text: renamed, write });
  assert.equal(w.created, true);
  assert.equal(api.writeManagedPipeline({ fs, managedDir, name: "copy", text: renamed, write }).created, false);
  assert.equal(api.readManagedText(fs, managedDir, "copy"), renamed);
  assert.equal(api.deleteManagedPipeline({ fs, managedDir, name: "copy" }), true);
  assert.equal(api.deleteManagedPipeline({ fs, managedDir, name: "copy" }), false);
  for (const bad of ["../evil", "a/b", "..", "", "/etc/passwd"]) {
    assert.throws(() => api.writeManagedPipeline({ fs, managedDir, name: bad, text: "x", write }), /unsafe/);
    assert.throws(() => api.deleteManagedPipeline({ fs, managedDir, name: bad }), /unsafe/);
  }
});

// ---- routes, through the real router ----

async function withRouter(fn, { home } = {}) {
  const lines = tmp();
  const router = await startRouter(lines, home ? { CUCK_HOME: home } : {});
  const call = async (method, url, body, raw) => {
    const res = await fetch(router.base + url, { method,
      headers: body !== undefined || raw !== undefined ? { "Content-Type": "application/json" } : {},
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try { await fn({ call, lines, router }); } finally { await stopRouter(router); }
}

const mine = (name, extra = "") => defaultText.replace("name: default", `name: ${name}`) + extra;

test("router: GET /api/pipelines lists pipelines, node types and interactions", async () => {
  await withRouter(async ({ call }) => {
    const r = await call("GET", "/api/pipelines");
    assert.equal(r.status, 200);
    const def = r.body.pipelines.find((p) => p.name === "default");
    assert.deepEqual(def, { name: "default", description: def.description, layer: "built-in", editable: false, problems: [] });
    assert.ok(r.body.pipelines.some((p) => p.name === "minimal"));
    assert.ok(r.body.nodeTypes.some((t) => t.name === "planner" && t.layer === "built-in"));
    assert.ok(r.body.interactions.some((i) => i.name === "report"));
    assert.equal((await call("POST", "/api/pipelines", {})).status, 405);
  });
});

test("router: GET /api/pipelines/:name", async () => {
  await withRouter(async ({ call }) => {
    const r = await call("GET", "/api/pipelines/default");
    assert.equal(r.status, 200);
    assert.equal(r.body.name, "default");
    assert.equal(r.body.layer, "built-in");
    assert.equal(r.body.editable, false);
    assert.equal(r.body.text, defaultText);
    assert.deepEqual(r.body.errors, []);
    assert.equal(r.body.resolved.start, "planner");
    assert.equal((await call("GET", "/api/pipelines/nope")).status, 404);
    assert.equal((await call("GET", "/api/pipelines/..%2Fetc")).status, 404);
    assert.equal((await call("GET", "/api/pipelines/%E0%A4%A")).status, 404);
    assert.equal((await call("GET", "/api/pipelines/default/extra/more")).status, 404);
  });
});

test("router: POST /api/pipelines/validate", async () => {
  await withRouter(async ({ call, lines }) => {
    const ok = await call("POST", "/api/pipelines/validate", { text: mine("probe") });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.errors, []);
    assert.equal(ok.body.graph.nodes.length, 6);
    assert.ok(ok.body.graph.nodes.every((n) => n.id && n.type && "phase" in n));
    assert.ok(ok.body.graph.edges.every((e) => e.from && e.to && Array.isArray(e.interactions)));
    assert.equal(fs.existsSync(path.join(lines, "plugins")), false, "validate writes nothing");

    const parse = await call("POST", "/api/pipelines/validate", { text: "name: [" });
    assert.equal(parse.status, 200);
    assert.equal(parse.body.errors[0].rule, "LOAD");
    assert.equal(parse.body.graph, null);

    const rule = await call("POST", "/api/pipelines/validate", { text: mine("probe").replace("start: planner", "start: integration") });
    assert.ok(rule.body.errors.length > 0);
    assert.ok(rule.body.errors.every((e) => typeof e.rule === "string" && typeof e.message === "string"));
    assert.equal(rule.body.graph, null);

    assert.equal((await call("POST", "/api/pipelines/validate", {})).status, 400);
    assert.equal((await call("POST", "/api/pipelines/validate", { text: 5 })).status, 400);
    assert.equal((await call("POST", "/api/pipelines/validate", undefined, "{bad")).status, 400);
    assert.equal((await call("GET", "/api/pipelines/validate")).status, 405);
  });
});

test("router: PUT, GET, DELETE a managed pipeline; running lines keep their copy", async () => {
  await withRouter(async ({ call, lines }) => {
    const text = mine("flow", "\n# note\n");
    const put = await call("PUT", "/api/pipelines/flow", { text });
    assert.equal(put.status, 201, JSON.stringify(put.body));
    const file = path.join(lines, "plugins", "pipelines", "flow.yaml");
    assert.equal(fs.readFileSync(file, "utf8"), text);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["flow.yaml"], "no temp file left");

    const got = await call("GET", "/api/pipelines/flow");
    assert.equal(got.body.layer, "managed");
    assert.equal(got.body.editable, true);
    assert.equal(got.body.text, text);
    const list = await call("GET", "/api/pipelines");
    assert.equal(list.body.pipelines.find((p) => p.name === "flow").editable, true);

    const again = await call("PUT", "/api/pipelines/flow", { text: text.replace("The planner", "A planner") });
    assert.equal(again.status, 200);
    assert.match((await call("GET", "/api/pipelines/flow")).body.resolved.description, /^A planner/);

    const line = await call("POST", "/api/lines", { name: "L", pipelineName: "flow" });
    assert.equal(line.status, 201);
    const del = await call("DELETE", "/api/pipelines/flow");
    assert.deepEqual([del.status, del.body], [200, { deleted: true }]);
    assert.equal(fs.existsSync(file), false);
    assert.equal((await call("GET", "/api/pipelines/flow")).status, 404);
    assert.equal((await call("POST", "/api/lines", { name: "M", pipelineName: "flow" })).status, 400);
    const saved = JSON.parse(fs.readFileSync(path.join(lines, line.body.id, "line.json"), "utf8"));
    assert.equal(saved.graph.name, "flow", "the line keeps its own copy");
    assert.equal((await call("DELETE", "/api/pipelines/flow")).status, 404);
  });
});

test("router: PUT errors", async () => {
  await withRouter(async ({ call, lines }) => {
    // built-in name: 403, nothing written
    const builtIn = await call("PUT", "/api/pipelines/default", { text: defaultText });
    assert.equal(builtIn.status, 403);
    assert.equal((await call("PUT", "/api/pipelines/minimal", { text: defaultText })).status, 403);
    assert.equal((await call("DELETE", "/api/pipelines/default")).status, 403);
    assert.equal(fs.existsSync(path.join(lines, "plugins")), false);

    // name mismatch, invalid pipeline, parse error: 400 with the error list
    const mismatch = await call("PUT", "/api/pipelines/a", { text: mine("b") });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.errors[0].rule, "NAME");
    const bad = await call("PUT", "/api/pipelines/a", { text: mine("a").replace("start: planner", "start: integration") });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.errors.length > 0);
    const parse = await call("PUT", "/api/pipelines/a", { text: "name: [" });
    assert.equal(parse.status, 400);
    assert.equal(parse.body.errors[0].rule, "LOAD");
    assert.equal((await call("PUT", "/api/pipelines/a", {})).status, 400);
    assert.equal((await call("PUT", "/api/pipelines/a", { text: 3 })).status, 400);
    assert.equal((await call("PUT", "/api/pipelines/a", undefined, "[1]")).status, 400);
    assert.equal(fs.existsSync(path.join(lines, "plugins", "pipelines", "a.yaml")), false);
  });
});

test("router: user-layer pipeline cannot be changed (403) but can be duplicated", async () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, "pipelines"));
  fs.writeFileSync(path.join(home, "pipelines", "from-user.yaml"), mine("from-user"));
  await withRouter(async ({ call }) => {
    const got = await call("GET", "/api/pipelines/from-user");
    assert.equal(got.body.layer, "user");
    assert.equal(got.body.editable, false);
    assert.equal((await call("PUT", "/api/pipelines/from-user", { text: mine("from-user") })).status, 403);
    assert.equal((await call("DELETE", "/api/pipelines/from-user")).status, 403);
    const dup = await call("POST", "/api/pipelines/from-user/duplicate", { newName: "from-user-2" });
    assert.equal(dup.status, 201);
    assert.equal((await call("GET", "/api/pipelines/from-user-2")).body.layer, "managed");
  }, { home });
});

test("router: path traversal in names never writes outside plugins/pipelines", async () => {
  await withRouter(async ({ call, lines }) => {
    // The router creates its own registry file shortly after it starts: it is not a write by these calls.
    const listing = () => fs.readdirSync(lines).filter((n) => n !== "work-coordination.json").sort();
    const before = listing();
    const names = ["..", "%2E%2E", "..%2Fevil", "%2E%2E%2F%2E%2E%2Fevil", "a%2Fb", "a%5Cb", "%2Fetc%2Fpasswd", "A", "a.b",
      "x".repeat(61), "-a", "a%00b"];
    for (const n of names) {
      const text = mine("evil");
      for (const [method, url, body] of [["PUT", `/api/pipelines/${n}`, { text }], ["DELETE", `/api/pipelines/${n}`],
        ["POST", `/api/pipelines/${n}/duplicate`, { newName: "ok-name" }]]) {
        const r = await call(method, url, body);
        assert.ok([400, 404].includes(r.status), `${method} ${url} -> ${r.status}`);
      }
    }
    for (const bad of ["../evil", "a/b", "..", "A", ""]) {
      assert.equal((await call("POST", "/api/pipelines/default/duplicate", { newName: bad })).status, 400, bad);
    }
    assert.equal((await call("PUT", "/api/pipelines/evil", { text: mine("../evil") })).status, 400);
    assert.deepEqual(listing(), before);
    assert.equal(fs.existsSync(path.join(path.dirname(lines), "evil.yaml")), false);
    assert.equal(fs.existsSync(path.join(lines, "plugins")), false);
    assert.equal(fs.existsSync(path.join(lines, "evil.yaml")), false);
  });
});

test("router: text over 256 KB is refused", async () => {
  await withRouter(async ({ call, lines }) => {
    const pad = (n) => mine("big", `\n# ${"x".repeat(n)}\n`);
    const fits = pad(200 * 1024);
    assert.equal((await call("PUT", "/api/pipelines/big", { text: fits })).status, 201);
    // text over the limit, body under 300 KB: clear 413 from the text rule
    const over = await call("PUT", "/api/pipelines/big", { text: pad(257 * 1024) });
    assert.equal(over.status, 413);
    assert.match(over.body.error, /256 KB/);
    // body over 300 KB: 413 from the body reader
    assert.equal((await call("PUT", "/api/pipelines/big", { text: pad(400 * 1024) })).status, 413);
    assert.equal((await call("POST", "/api/pipelines/validate", { text: pad(257 * 1024) })).status, 413);
    assert.equal(fs.readFileSync(path.join(lines, "plugins", "pipelines", "big.yaml"), "utf8"), fits);
  });
});

test("router: duplicate errors", async () => {
  await withRouter(async ({ call }) => {
    assert.equal((await call("POST", "/api/pipelines/default/duplicate", { newName: "default" })).status, 409);
    assert.equal((await call("POST", "/api/pipelines/default/duplicate", { newName: "minimal" })).status, 409);
    assert.equal((await call("POST", "/api/pipelines/nope/duplicate", { newName: "x" })).status, 404);
    assert.equal((await call("POST", "/api/pipelines/default/duplicate", {})).status, 400);
    assert.equal((await call("POST", "/api/pipelines/default/duplicate", { newName: "one" })).status, 201);
    assert.equal((await call("POST", "/api/pipelines/default/duplicate", { newName: "one" })).status, 409);
    assert.equal((await call("GET", "/api/pipelines/default/duplicate")).status, 405);
  });
});

test("router: duplicate a built-in, edit it with PUT, create a line from it", async () => {
  await withRouter(async ({ call, lines }) => {
    const dup = await call("POST", "/api/pipelines/default/duplicate", { newName: "fast" });
    assert.equal(dup.status, 201, JSON.stringify(dup.body));
    const got = await call("GET", "/api/pipelines/fast");
    assert.equal(got.body.name, "fast");
    assert.equal(got.body.layer, "managed");
    assert.equal(got.body.resolved.nodes["backend-impl"].type, "backend-implementor");
    assert.match(got.body.text, /^name: fast$/m);

    const edited = got.body.text.replace("  planner:       { type: planner }", "  planner:       { type: planner, model: sonnet-edit }");
    assert.notEqual(edited, got.body.text);
    assert.equal((await call("PUT", "/api/pipelines/fast", { text: edited })).status, 200);
    assert.equal((await call("GET", "/api/pipelines/fast")).body.resolved.nodes.planner.settings.model, "sonnet-edit");

    const line = await call("POST", "/api/lines", { name: "From fast", pipelineName: "fast" });
    assert.equal(line.status, 201, JSON.stringify(line.body));
    const saved = JSON.parse(fs.readFileSync(path.join(lines, line.body.id, "line.json"), "utf8"));
    assert.equal(saved.graph.name, "fast");
    assert.equal(saved.graph.nodes.planner.settings.model, "sonnet-edit");
  });
});
