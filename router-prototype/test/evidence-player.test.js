"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { selectEvidenceAttempt, clampEvidenceStep } = require("../web/pipeline-ui.js");

const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
const showcase = (id, attemptId, at = "2026-01-01T00:00:00Z") => ({
  id, attemptId, kind: "showcase", version: 1, at, useCase: "Safe title",
  steps: [{ title: "Step", explanation: "Explain", screenshot: "/shot.png" }],
});

test("attempt selection uses the authoritative current attempt, not newest evidence", () => {
  const old = showcase("old", "attempt-old", "2999-01-01T00:00:00Z");
  const current = showcase("current", "attempt-current");
  assert.strictEqual(selectEvidenceAttempt({ items: [current, old], currentAttemptId: "attempt-current" }).primary.id, "current");
});

test("current attempt without evidence does not promote history", () => {
  const old = showcase("old", "attempt-old");
  const result = selectEvidenceAttempt({ items: [], history: [old], currentAttemptId: "attempt-current" });
  assert.strictEqual(result.primary, null);
  assert.deepStrictEqual(result.history, [old]);
});

test("history remains separate and legacy records stay visible", () => {
  const current = showcase("current", "a");
  const legacy = { id: "legacy", useCase: "Legacy", at: "2020", video: "/old.webm" };
  const result = selectEvidenceAttempt({ items: [current, legacy], currentAttemptId: "a" });
  assert.deepStrictEqual(result.history, [legacy]);
});

test("ambiguous current attempt is not guessed", () => {
  const result = selectEvidenceAttempt({ items: [showcase("a", "a")], currentAttemptIds: { x: "a", y: "b" } });
  assert.strictEqual(result.primary, null);
  assert.strictEqual(result.ambiguous, true);
});

test("step navigation clamps at both boundaries and supports empty steps", () => {
  assert.strictEqual(clampEvidenceStep(-2, 3), 0);
  assert.strictEqual(clampEvidenceStep(99, 3), 2);
  assert.strictEqual(clampEvidenceStep(1, 0), 0);
});

test("polling rejects stale responses and preserves the evidence video node", () => {
  assert.match(html, /gen !== st\.evidenceGen/);
  assert.match(html, /view\.videoUrl !==/);
  assert.match(html, /video\.currentTime/);
  assert.match(html, /video\.addEventListener\("timeupdate"/);
  assert.doesNotMatch(html, /pane\.innerHTML = "";[\s\S]{0,80}renderEvidence/);
});

test("missing screenshots have an explicit state and retain step copy", () => {
  assert.match(html, /Screenshot unavailable for this step/);
  assert.match(html, /image\.addEventListener\("error"/);
  assert.match(html, /view\.title\.textContent/);
  assert.match(html, /view\.explanation\.textContent/);
});

test("navigation has named controls and limits", () => {
  assert.match(html, /prev\.textContent = "Previous"/);
  assert.match(html, /next\.textContent = "Next"/);
  assert.match(html, /view\.prev\.disabled = selected === 0/);
  assert.match(html, /view\.next\.disabled = selected >= steps\.length - 1/);
});

test("responsive evidence layout remains two-column then one-column", () => {
  assert.match(html, /\.evSlides \{[^}]*grid-template-columns: minmax/);
  assert.match(html, /@media \(max-width: 640px\)[\s\S]*\.evSlides \{ grid-template-columns: 1fr; \}/);
});

test("legacy media and missing video state are rendered", () => {
  assert.match(html, /item\.video/);
  assert.match(html, /Video unavailable\./);
  assert.match(html, /title\.textContent = showcase \? "Previous evidence" : "Evidence history"/);
});

test("safe text rendering uses textContent for evidence copy", () => {
  assert.match(html, /view\.heading\.textContent/);
  assert.match(html, /view\.title\.textContent/);
  assert.match(html, /view\.explanation\.textContent/);
  assert.doesNotMatch(html, /view\.(heading|title|explanation)\.innerHTML/);
});

test("native video controls, keyboard buttons, alt text, and cleanup are present", () => {
  assert.match(html, /video\.controls = true/);
  assert.match(html, /video\.preload = "metadata"/);
  assert.match(html, /image\.alt = step\.title/);
  assert.match(html, /st\.historyView\.node\.remove\(\)/);
});
