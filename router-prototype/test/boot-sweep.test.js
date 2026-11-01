"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startRouter, stopRouter, wait } = require("./fixtures/router-process");

// A docker stub. It records its arguments. For a per-line `ps` filter it
// lists the container "c-<lineId>" when `listed` is true. For the old global
// filter it lists "c-bad" for line-bad, so the old sweep fails this test.
function recordingDocker(log, listed) {
  return [
    "#!/bin/sh",
    `echo "$*" >> "${log}"`,
    '[ "$1" = ps ] || exit 0',
    'for a in "$@"; do',
    '  case "$a" in',
    "    label=cuck.line) printf 'c-bad\\tline-bad\\n' ;;",
    `    label=cuck.line=*) ${listed ? 'echo "c-${a#label=cuck.line=}"' : ":"} ;;`,
    "  esac",
    "done",
    "",
  ].join("\n");
}

// The sweep runs after the router answers. Poll; do not use a fixed delay.
async function until(predicate, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await wait(50);
  }
  return predicate();
}

async function bootWith(t, setup, listed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boot-sweep-"));
  const log = path.join(root, "..", `${path.basename(root)}-docker.log`);
  fs.writeFileSync(log, "");
  setup(root);
  const router = await startRouter(root, {}, { docker: recordingDocker(log, listed) });
  t.after(async () => {
    await stopRouter(router);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(log, { force: true });
  });
  return { root, calls: () => fs.readFileSync(log, "utf8") };
}

test("removes containers of a tombstoned line and keeps those of a corrupt line", { timeout: 30_000 }, async (t) => {
  const { calls } = await bootWith(t, (root) => {
    fs.mkdirSync(path.join(root, "line-bad"));
    fs.writeFileSync(path.join(root, "line-bad", "line.json"), "{");
    fs.mkdirSync(path.join(root, ".deleted"));
    fs.writeFileSync(path.join(root, ".deleted", "line-gone"), "x");
  }, true);
  assert.ok(await until(() => /^rm -fv c-line-gone$/m.test(calls())), calls());
  assert.doesNotMatch(calls(), /c-bad/);
});

test("forgets a tombstone when no container remains", { timeout: 30_000 }, async (t) => {
  const { root } = await bootWith(t, (dir) => {
    fs.mkdirSync(path.join(dir, ".deleted"));
    fs.writeFileSync(path.join(dir, ".deleted", "line-gone"), "x");
  }, false);
  const tombstone = path.join(root, ".deleted", "line-gone");
  assert.ok(await until(() => !fs.existsSync(tombstone)));
});
