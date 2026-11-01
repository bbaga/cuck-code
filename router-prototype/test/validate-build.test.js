"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateBuild } = require("../scripts/validate-build");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cuck-build-check-"));
  for (const file of [
    "server.js", "http-guard.js", "harness.js", "pipeline-config.js", "planner-turn.js", "spawn-plan.js",
    "handoff.js", "jsonl.js", "validation-queue.js", "planner-request.js", "transcript-history.js",
    "web/pipeline-ui.js", "web/worker-scope.js", "web/markdown-renderer.js", "web/registry-ui.js", "web/registry-ui-extra.js", "web/registry-line.js", "web/index.html",
  ]) {
    const filename = path.join(root, file);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, "// valid JavaScript\n");
  }
  fs.writeFileSync(path.join(root, "web/index.html"), [
    '<script src="https://cdn.example.test/library.js"></script>',
    '<script src="pipeline-ui.js"></script>',
    "<script>const inlineOkay = true;</script>",
  ].join("\n"));
  return root;
}

function withFixture(run) {
  const root = fixture();
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("accepts valid production scripts, inline scripts, and local assets", () => {
  withFixture((root) => {
    assert.equal(validateBuild(root).length, 19);
  });
});

test("rejects malformed production JavaScript", () => {
  withFixture((root) => {
    fs.writeFileSync(path.join(root, "server.js"), "function broken( {");
    assert.throws(() => validateBuild(root), /Invalid JavaScript in server\.js/);
  });
});

test("rejects malformed inline JavaScript without executing it", () => {
  withFixture((root) => {
    fs.writeFileSync(path.join(root, "web/index.html"), "<script>function broken( {</script>");
    assert.throws(() => validateBuild(root), /Invalid JavaScript in web\/index\.html inline script 1/);
  });
});

test("rejects missing required local web assets", () => {
  withFixture((root) => {
    fs.rmSync(path.join(root, "web/pipeline-ui.js"));
    assert.throws(() => validateBuild(root), /Missing required web asset: web\/pipeline-ui\.js/);
  });
});

test("rejects a missing registry line asset", () => {
  withFixture((root) => {
    fs.rmSync(path.join(root, "web/registry-line.js"));
    assert.throws(() => validateBuild(root), /Missing required web asset: web\/registry-line\.js/);
  });
});

test("rejects a missing markdown renderer asset", () => {
  withFixture((root) => {
    fs.rmSync(path.join(root, "web/markdown-renderer.js"));
    assert.throws(() => validateBuild(root), /Missing required web asset: web\/markdown-renderer\.js/);
  });
});
