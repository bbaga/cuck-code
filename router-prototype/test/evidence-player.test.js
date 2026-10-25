"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { selectEvidenceAttempt, clampEvidenceStep, renderEvidenceFromState, evidencePollIsCurrent } = require("../web/pipeline-ui.js");

class Element {
  constructor(doc, tag) { this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.listeners = {}; this.hidden = false; this.disabled = false; this.currentTime = 0; this.textContent = ""; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) { if (node.parentNode) node.parentNode.children = node.parentNode.children.filter((child) => child !== node); node.parentNode = this; this.children.push(node); return node; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  dispatch(name) { for (const fn of this.listeners[name] || []) fn({ target: this }); }
  click() { if (!this.disabled) this.dispatch("click"); }
  replaceWith(node) { if (!this.parentNode) return; const p = this.parentNode; const i = p.children.indexOf(this); p.children[i] = node; node.parentNode = p; this.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this); this.parentNode = null; }
  get isConnected() { return Boolean(this.parentNode) && (this.parentNode === this.ownerDocument.body || this.parentNode.isConnected); }
  set innerHTML(value) { if (value === "") { for (const child of this.children) child.parentNode = null; this.children = []; } }
  get innerHTML() { return ""; }
}
class Document { constructor() { this.body = new Element(this, "body"); } createElement(tag) { return new Element(this, tag); } }
function makeState() { const doc = new Document(); const pane = doc.createElement("div"); doc.body.appendChild(pane); return { evPane: pane, evidenceState: null, evidenceResponse: null }; }
function showcase(id = "current", attemptId = "attempt-current") { return { id, attemptId, kind: "showcase", version: 1, at: "2026-01-01T00:00:00Z", name: "demo.webm", video: "/video.webm", useCase: "Use case", steps: [
  { title: "First", explanation: "First explanation", screenshot: "/one.png" },
  { title: "Second", explanation: "Second explanation", screenshot: "/two.png" },
] }; }

 test("attempt selection uses the authoritative current attempt", () => {
  const old = { ...showcase("old", "old"), at: "2999-01-01" }; const current = showcase();
  assert.strictEqual(selectEvidenceAttempt({ items: [current, old], currentAttemptId: "attempt-current" }).primary, current);
});
test("current items empty never promotes history", () => {
  const old = showcase("old", "old"); const result = selectEvidenceAttempt({ items: [], history: [old], currentAttemptId: "new" });
  assert.strictEqual(result.primary, null); assert.deepStrictEqual(result.history, [old]);
});
test("renderer keeps video identity, playback, slide, copy, and counter on identical polls", () => {
  const st = makeState(); const current = showcase(); const response = { items: [current], history: [], currentAttemptId: current.attemptId };
  st.evidenceResponse = response; renderEvidenceFromState(st, response);
  const video = st.evidenceView.video; st.evidenceState.step = 1; st.evidenceResponse = response; st.evidenceView.next.click();
  st.evidenceView.video.currentTime = 42; st.evidenceView.video.dispatch("timeupdate");
  const image = st.evidenceView.slide.children[0]; const title = st.evidenceView.title.textContent;
  renderEvidenceFromState(st, response);
  assert.strictEqual(st.evidenceView.video, video); assert.strictEqual(video.currentTime, 42);
  assert.strictEqual(st.evidenceState.step, 1); assert.strictEqual(st.evidenceView.title.textContent, title);
  assert.strictEqual(st.evidenceView.explanation.textContent, "Second explanation");
  assert.strictEqual(st.evidenceView.counter.textContent, "2 of 2"); assert.strictEqual(st.evidenceView.slide.children[0], image);
  assert.strictEqual(st.evidenceView.slide.children[0].src, image.src);
});
test("unchanged polls retain screenshot node and image error state", () => {
  const st = makeState(); const current = showcase(); const response = { items: [current], history: [], currentAttemptId: current.attemptId };
  renderEvidenceFromState(st, response); const image = st.evidenceView.image; image.dispatch("error");
  const missing = st.evidenceView.imageMissing; renderEvidenceFromState(st, response);
  assert.strictEqual(st.evidenceView.image, image); assert.strictEqual(st.evidenceView.imageMissing, missing);
  assert.strictEqual(image.hidden, true); assert.strictEqual(missing.hidden, false);
});
test("history stays visible when current items stay empty", () => {
  const st = makeState(); const old = { id: "old", at: "old", useCase: "Old", video: "/old.webm" };
  const first = { items: [], history: [old], currentAttemptId: "current" }; renderEvidenceFromState(st, first);
  const history = st.historyView.node; renderEvidenceFromState(st, first);
  assert.strictEqual(st.historyView.node, history); assert.strictEqual(history.isConnected, true);
  const newer = { id: "new", at: "new", useCase: "New", video: "/new.webm" };
  renderEvidenceFromState(st, { ...first, history: [old, newer] });
  assert.notStrictEqual(st.historyView.node, history); assert.strictEqual(st.historyView.node.children.length, 3);
});
test("current showcase without a video has an explicit unavailable state", () => {
  const st = makeState(); const current = showcase(); delete current.video;
  const response = { items: [current], history: [], currentAttemptId: current.attemptId }; renderEvidenceFromState(st, response);
  assert.strictEqual(st.evidenceView.video.hidden, true); assert.strictEqual(st.evidenceView.videoUnavailable.hidden, false);
  assert.match(st.evidenceView.videoUnavailable.textContent, /Video unavailable/); assert.strictEqual(st.evidenceView.title.textContent, "First");
});
test("history-only poll changes do not reset the primary showcase", () => {
  const st = makeState(); const current = showcase(); const first = { items: [current], history: [], currentAttemptId: current.attemptId };
  renderEvidenceFromState(st, first); const video = st.evidenceView.video; st.evidenceState.step = 1; video.currentTime = 9;
  const second = { ...first, history: [{ id: "old", at: "old", useCase: "Old", video: "/old.webm" }] };
  renderEvidenceFromState(st, second); assert.strictEqual(st.evidenceView.video, video); assert.strictEqual(video.currentTime, 9); assert.strictEqual(st.evidenceState.step, 1);
  assert.strictEqual(st.historyView.node.children.length, 2);
});
test("navigation handlers enforce boundaries and retain selected slide", () => {
  const st = makeState(); const current = showcase(); const response = { items: [current], history: [], currentAttemptId: current.attemptId };
  st.evidenceResponse = response; renderEvidenceFromState(st, response);
  assert.strictEqual(st.evidenceView.prev.disabled, true); st.evidenceView.prev.click(); assert.strictEqual(st.evidenceState.step, 0);
  st.evidenceView.next.click(); assert.strictEqual(st.evidenceState.step, 1); assert.strictEqual(st.evidenceView.next.disabled, true);
});
test("missing media and image failures show visible states without losing copy", () => {
  const st = makeState(); const current = showcase(); current.steps[0].screenshot = null;
  const response = { items: [current], history: [], currentAttemptId: current.attemptId }; renderEvidenceFromState(st, response);
  assert.match(st.evidenceView.slide.children[0].textContent, /Screenshot unavailable/); assert.strictEqual(st.evidenceView.title.textContent, "First");
  current.steps[0].screenshot = "/broken.png"; renderEvidenceFromState(st, response); const image = st.evidenceView.slide.children[0]; const missing = st.evidenceView.slide.children[2];
  image.dispatch("error"); assert.strictEqual(image.hidden, true); assert.strictEqual(missing.hidden, false); assert.strictEqual(st.evidenceView.explanation.textContent, "First explanation");
});
test("evidence copy is safe text and current/history records remain separate", () => {
  const st = makeState(); const current = showcase(); current.useCase = "<script>bad</script>"; current.steps[0].title = "<b>title</b>";
  const old = { id: "old", at: "old", useCase: "Old", video: "/old.webm" }; const response = { items: [current], history: [old], currentAttemptId: current.attemptId };
  renderEvidenceFromState(st, response); assert.strictEqual(st.evidenceView.heading.textContent, "<script>bad</script>"); assert.strictEqual(st.evidenceView.title.textContent, "<b>title</b>"); assert.strictEqual(st.historyView.node.children.length, 2);
});
test("ambiguous attempt has no primary showcase", () => {
  const st = makeState(); const response = { items: [showcase()], history: [], currentAttemptIds: { a: "a", b: "b" } }; renderEvidenceFromState(st, response);
  assert.strictEqual(st.emptyView.text, "Current evidence attempt is ambiguous; history is shown below.");
});
test("navigation helper clamps both boundaries", () => { assert.strictEqual(clampEvidenceStep(-2, 2), 0); assert.strictEqual(clampEvidenceStep(8, 2), 1); assert.strictEqual(clampEvidenceStep(1, 0), 0); });
test("production polling rejects stale responses and keeps visible focus styling", () => {
  const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "../web/pipeline-ui.js"), "utf8");
  const st = { evidenceGen: 2 }; const other = { evidenceGen: 2 };
  assert.strictEqual(evidencePollIsCurrent(st, "line", 2, "line", st), true);
  assert.strictEqual(evidencePollIsCurrent(st, "line", 1, "line", st), false);
  assert.strictEqual(evidencePollIsCurrent(st, "line", 2, "other", st), false);
  assert.strictEqual(evidencePollIsCurrent(st, "line", 2, "line", other), false);
  assert.match(html, /evidencePollIsCurrent/); assert.match(html, /:focus-visible/); assert.match(renderer, /video\.controls = true/);
});
