"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the actual inline UI helpers without a browser or a running agent.
const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
const helpers = html.slice(html.indexOf("  function selectNode("), html.indexOf("  function addCard("));
const ui = vm.runInNewContext(helpers + `
  ({ setupTranscriptScroll, syncTranscriptScroll, appendEntry, renderTranscript, selectNode })
`, {
  ResizeObserver: class {
    constructor(callback) { this.callback = callback; }
    observe() {}
  },
  document: { createElement: () => ({ height: 20 }) },
  entryEl: (entry) => entry,
  renderGraph: () => {},
});

function element() {
  const handlers = new Map();
  return {
    hidden: true,
    addEventListener(type, handler) { handlers.set(type, handler); },
    fire(type) { handlers.get(type)(); },
  };
}

function state() {
  let top = 0;
  const transcript = Object.assign(element(), {
    clientHeight: 200,
    scrollHeight: 1000,
    appendChild(entry) { this.scrollHeight += entry.height; },
  });
  Object.defineProperties(transcript, {
    innerHTML: { set(value) { this.scrollHeight = 0; top = 0; } },
    scrollTop: {
      get() { return top; },
      set(value) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    },
  });
  const st = {
    transcript, scrollBottomBtn: element(), selected: null,
    plannerTranscript: [], workers: new Map(), workerTranscripts: new Map(),
    tabEvBtn: element(),
  };
  ui.setupTranscriptScroll(st);
  ui.syncTranscriptScroll(st);
  return st;
}

function scrollTo(st, top) {
  st.transcript.scrollTop = top;
  st.transcript.fire("scroll");
}

function atBottom(st) {
  return st.transcript.scrollHeight - st.transcript.clientHeight;
}

test("new entries follow the stream by default", () => {
  const st = state();
  ui.appendEntry(st, { height: 100 });
  assert.equal(st.transcript.scrollTop, atBottom(st));
  assert.equal(st.scrollBottomBtn.hidden, true);
});

test("scrolling up pauses follow and new entries preserve the reading position", () => {
  const st = state();
  scrollTo(st, 300);
  assert.equal(st.followTranscript, false);
  assert.equal(st.scrollBottomBtn.hidden, false);
  ui.appendEntry(st, { height: 100 });
  ui.appendEntry(st, { height: 200 });
  assert.equal(st.transcript.scrollTop, 300);
});

test("scrolling back to the newest messages resumes follow (with rounding tolerance)", () => {
  const st = state();
  scrollTo(st, 300);
  scrollTo(st, atBottom(st) - 3);
  assert.equal(st.followTranscript, true);
  assert.equal(st.scrollBottomBtn.hidden, true);
  ui.appendEntry(st, { height: 100 });
  assert.equal(st.transcript.scrollTop, atBottom(st));
});

test("scroll-to-bottom button jumps to the latest entry and resumes follow", () => {
  const st = state();
  scrollTo(st, 300);
  ui.appendEntry(st, { height: 100 });
  st.scrollBottomBtn.fire("click");
  assert.equal(st.transcript.scrollTop, atBottom(st));
  assert.equal(st.followTranscript, true);
  assert.equal(st.scrollBottomBtn.hidden, true);
  ui.appendEntry(st, { height: 100 });
  assert.equal(st.transcript.scrollTop, atBottom(st));
});

test("hidden tabs and lines retain their follow state", () => {
  const st = state();
  scrollTo(st, 300);
  st.transcript.clientHeight = 0;
  st.transcript.fire("scroll");
  ui.appendEntry(st, { height: 100 });
  assert.equal(st.followTranscript, false);
  assert.equal(st.transcript.scrollTop, 300);
  st.transcript.clientHeight = 200;
  ui.syncTranscriptScroll(st);
  assert.equal(st.transcript.scrollTop, 300);
  st.scrollBottomBtn.fire("click");
  st.transcript.clientHeight = 0;
  ui.appendEntry(st, { height: 100 });
  st.transcript.clientHeight = 200;
  ui.syncTranscriptScroll(st);
  assert.equal(st.transcript.scrollTop, atBottom(st));
});

test("viewport resizing follows only when follow is enabled", () => {
  const st = state();
  st.transcript.clientHeight = 100;
  st.transcriptResizeObserver.callback();
  assert.equal(st.transcript.scrollTop, atBottom(st));
  scrollTo(st, 300);
  st.transcript.clientHeight = 200;
  st.transcriptResizeObserver.callback();
  assert.equal(st.transcript.scrollTop, 300);
});

test("transcript snapshots preserve a paused position for planner and worker streams", () => {
  const st = state();
  st.plannerTranscript = Array.from({ length: 15 }, () => ({ height: 100 }));
  scrollTo(st, 300);
  ui.renderTranscript(st);
  assert.equal(st.transcript.scrollTop, 300);
  assert.equal(st.followTranscript, false);
  st.selected = "worker";
  st.workerTranscripts.set("worker", st.plannerTranscript);
  ui.renderTranscript(st);
  assert.equal(st.transcript.scrollTop, 300);
  assert.equal(st.followTranscript, false);
});

test("switching agent streams starts at the newest messages", () => {
  const st = state();
  scrollTo(st, 300);
  st.workerTranscripts.set("worker", Array.from({ length: 15 }, () => ({ height: 100 })));
  ui.selectNode(st, "worker");
  assert.equal(st.followTranscript, true);
  assert.equal(st.transcript.scrollTop, atBottom(st));
  scrollTo(st, 300);
  ui.selectNode(st, "worker");
  assert.equal(st.followTranscript, false);
  assert.equal(st.transcript.scrollTop, 300);
});
