"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  CHANGESET_LIMIT,
  parseNumstatLine,
  parseNumstat,
  summarizeChanges,
  collectChangeset,
  changesetWakeMessage,
  changesetFields,
} = require("../changeset");

function fakeRun({ numstat = "", status = "", fail = [] } = {}) {
  return (args) => {
    if (fail.includes(args[0])) return { status: 1, stdout: "" };
    if (args[0] === "rev-parse") return { status: 0, stdout: "headabc123\n" };
    if (args[0] === "diff") return { status: 0, stdout: numstat };
    if (args[0] === "status") return { status: 0, stdout: status };
    return { status: 1, stdout: "" };
  };
}

function numstatRow(path, additions, deletions) {
  return `${additions}\t${deletions}\t${path}`;
}

test("parses a normal numstat line", () => {
  assert.deepEqual(parseNumstatLine("12\t3\tsrc/a.js"),
    { path: "src/a.js", binary: false, additions: 12, deletions: 3 });
});

test("parses a binary numstat row with dashes", () => {
  assert.deepEqual(parseNumstatLine("-\t-\timg/logo.png"),
    { path: "img/logo.png", binary: true, additions: 0, deletions: 0 });
});

test("rejects malformed numstat lines", () => {
  assert.equal(parseNumstatLine(""), null);
  assert.equal(parseNumstatLine("no-tabs-here"), null);
  assert.equal(parseNumstatLine("1\t2\t"), null);
  assert.equal(parseNumstatLine("x\ty\tfile"), null);
  assert.equal(parseNumstatLine(null), null);
});

test("parses full numstat output and skips empty lines", () => {
  const rows = parseNumstat("1\t2\ta.js\r\n\r\n-\t-\tb.png\n");
  assert.deepEqual(rows, [
    { path: "a.js", binary: false, additions: 1, deletions: 2 },
    { path: "b.png", binary: true, additions: 0, deletions: 0 },
  ]);
  assert.deepEqual(parseNumstat(null), []);
});

test("summarizes additions plus deletions with sorted per-file rows", () => {
  const summary = summarizeChanges([
    { path: "z.js", binary: false, additions: 10, deletions: 2 },
    { path: "a.js", binary: false, additions: 3, deletions: 4 },
  ]);
  assert.equal(summary.additions, 13);
  assert.equal(summary.deletions, 6);
  assert.equal(summary.total, 19);
  assert.deepEqual(summary.files.map((f) => f.path), ["a.js", "z.js"]);
});

test("counts an empty change set as zero", () => {
  const cs = collectChangeset("/wt", "base123", { run: fakeRun() });
  assert.equal(cs.ok, true);
  assert.equal(cs.total, 0);
  assert.equal(cs.reason, null);
});

test("accepts 499 changed lines", () => {
  const cs = collectChangeset("/wt", "base123", {
    run: fakeRun({ numstat: numstatRow("a.js", 400, 99) }),
  });
  assert.equal(cs.ok, true);
  assert.equal(cs.total, 499);
  assert.equal(cs.limit, CHANGESET_LIMIT);
});

test("accepts exactly 500 changed lines", () => {
  const cs = collectChangeset("/wt", "base123", {
    run: fakeRun({ numstat: numstatRow("a.js", 250, 250) }),
  });
  assert.equal(cs.ok, true);
  assert.equal(cs.total, 500);
});

test("rejects 501 changed lines as oversized", () => {
  const cs = collectChangeset("/wt", "base123", {
    run: fakeRun({ numstat: `${numstatRow("a.js", 250, 250)}\n${numstatRow("b.js", 1, 0)}` }),
  });
  assert.equal(cs.ok, false);
  assert.equal(cs.reason, "oversized");
  assert.equal(cs.total, 501);
});

test("rejects 766 additions plus 15 deletions", () => {
  const cs = collectChangeset("/wt", "base123", {
    run: fakeRun({ numstat: `${numstatRow("big.js", 700, 10)}\n${numstatRow("more.js", 66, 5)}` }),
  });
  assert.equal(cs.ok, false);
  assert.equal(cs.reason, "oversized");
  assert.equal(cs.additions, 766);
  assert.equal(cs.deletions, 15);
  assert.equal(cs.total, 781);
});

test("escalates a binary file", () => {
  const cs = collectChangeset("/wt", "base123", {
    run: fakeRun({ numstat: `-\t-\tlogo.png\n${numstatRow("a.js", 10, 1)}` }),
  });
  assert.equal(cs.ok, false);
  assert.equal(cs.reason, "binary");
  assert.deepEqual(cs.binaryPaths, ["logo.png"]);
});

test("escalates dirty work", () => {
  const cs = collectChangeset("/wt", "base123", {
    run: fakeRun({ status: " M a.js\n" }),
  });
  assert.equal(cs.ok, false);
  assert.equal(cs.reason, "dirty");
  assert.deepEqual(cs.dirtyPaths, ["a.js"]);
});

test("escalates untracked work", () => {
  const cs = collectChangeset("/wt", "base123", {
    run: fakeRun({ status: "?? new.txt\n" }),
  });
  assert.equal(cs.ok, false);
  assert.equal(cs.reason, "untracked");
  assert.deepEqual(cs.untrackedPaths, ["new.txt"]);
});

test("reports an uncountable change set without a base commit", () => {
  const cs = collectChangeset("/wt", null, { run: fakeRun() });
  assert.equal(cs.ok, false);
  assert.equal(cs.reason, "uncountable");
});

test("reports an uncountable change set when git fails", () => {
  const cs = collectChangeset("/wt", "base123", { run: fakeRun({ fail: ["diff"] }) });
  assert.equal(cs.ok, false);
  assert.equal(cs.reason, "uncountable");
});

test("a custom limit overrides the default", () => {
  const cs = collectChangeset("/wt", "base123", {
    limit: 10,
    run: fakeRun({ numstat: numstatRow("a.js", 6, 5) }),
  });
  assert.equal(cs.ok, false);
  assert.equal(cs.reason, "oversized");
  assert.equal(cs.limit, 10);
});

test("a continued run keeps the same base commit and grows the total", () => {
  const run1 = fakeRun({ numstat: numstatRow("a.js", 100, 10) });
  const run2 = fakeRun({ numstat: `${numstatRow("a.js", 100, 10)}\n${numstatRow("b.js", 50, 5)}` });
  const base = "base123";
  const first = collectChangeset("/wt", base, { run: run1 });
  const second = collectChangeset("/wt", base, { run: run2 });
  assert.equal(first.baseCommit, base);
  assert.equal(second.baseCommit, base);
  assert.equal(second.total, first.total + 55);
});

test("the wake message carries worker, commits, totals, and paths", () => {
  const cs = collectChangeset("/wt", "base123", {
    run: fakeRun({ numstat: `-\t-\tlogo.png\n${numstatRow("a.js", 300, 201)}` }),
  });
  const msg = changesetWakeMessage(cs, { id: "w1", name: "impl-1",
    sessionId: "s-77", branch: "br" });
  assert.ok(msg.startsWith("CHANGESET LIMIT EXCEEDED"));
  assert.ok(msg.includes("workerId w1"));
  assert.ok(msg.includes("session s-77"));
  assert.ok(msg.includes("Base commit base123"));
  assert.ok(msg.includes("head commit headabc123"));
  assert.ok(msg.includes("Additions 300, deletions 201, total 501"));
  assert.ok(msg.includes("logo.png"));
  assert.ok(msg.includes("a.js: +300/-201"));
  assert.ok(msg.includes("/continue"));
});

test("change-set fields survive a JSON round trip (persistence and restart)", () => {
  const cs = collectChangeset("/wt", "base123", {
    run: fakeRun({ numstat: numstatRow("a.js", 600, 0) }),
  });
  const worker = { baseCommit: "base123", changeset: cs };
  const restored = JSON.parse(JSON.stringify(changesetFields(worker)));
  assert.equal(restored.baseCommit, "base123");
  assert.equal(restored.changeset.total, 600);
  assert.equal(restored.changeset.reason, "oversized");
  assert.deepEqual(changesetFields({}), { baseCommit: null, changeset: null });
});
