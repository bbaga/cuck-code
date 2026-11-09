"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openPage } = require("./fixtures/browser-driver");

const PAGES = 6;
// A private temp folder keeps profile folders of other processes out of the check.
// The driver reads its lock path at load time, so the shared lock stays shared.
const privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), "launch-test-"));
process.env.TMPDIR = privateTmp;
const profiles = () => new Set(fs.readdirSync(privateTmp).filter((n) => n.startsWith("browser-driver-")));

test("six pages launch in parallel and leave no profile folder", async (t) => {
  const before = profiles();
  const opened = await Promise.allSettled(
    Array.from({ length: PAGES }, () => openPage("data:text/html,<title>x</title>")),
  );
  const pages = opened.filter((r) => r.status === "fulfilled").map((r) => r.value);
  try {
    const failed = opened.find((r) => r.status === "rejected");
    if (failed && failed.reason.code === "BROWSER_UNAVAILABLE") return t.skip("Chrome is missing: " + failed.reason.message);
    if (failed) throw failed.reason;
    const results = await Promise.all(pages.map((p) => p.evaluate("1+1")));
    assert.deepEqual(results, Array(PAGES).fill(2));
  } finally {
    await Promise.all(pages.map((p) => p.close()));
  }
  const leftover = [...profiles()].filter((n) => !before.has(n));
  fs.rmSync(privateTmp, { recursive: true, force: true });
  assert.deepEqual(leftover, []);
});
