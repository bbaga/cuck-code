"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
const slice = (from, to) => { const s = html.indexOf(from); return html.slice(s, html.indexOf(to, s)); };
const source = slice("  function renderScopePanel(", "  // Context meter") + slice("  function setLineTab(", "  const registryToggle");

function harness(opts = {}) {
  const calls = [];
  const ui = vm.runInNewContext(source + "\n({ setLineTab, renderScopePanel })", {
    formatScopePanelData: () => "scope", registryLine: { mount: () => ({ load() { calls.push("work"); } }) },
    document: {}, window: {}, fetch() {}, reloadPresets() {}, pollInventory() {}, pollEvidence() {}, syncTranscriptScroll() {},
    renderGraph: (st) => { calls.push("graph"); if (opts.preview) st.previewPanel.hidden = false; },
  });
  const el = () => ({ hidden: false, classList: { toggle() {} } });
  const planDetails = el(), planBody = { parentNode: opts.approved ? planDetails : null };
  const st = { id: "line-a", tab: "line", planBody, planDetails, plan: el(), graphDetails: el(), previewPanel: el(), transcriptWrap: el(),
    chatHandle: el(), row: el(), procPane: el(), evPane: el(), pipePane: el(), workPane: el(), scopeDetails: el(), scopeText: {},
    tabLineBtn: el(), tabProcBtn: el(), tabEvBtn: el(), tabPipeBtn: el(), tabWorkBtn: el(), pipeForm: { open() {} },
    selected: "w1", workers: new Map([["w1", { role: "implementor" }]]) };
  return { ui, st, calls };
}

test("Work tab hides scope, preview and plan panels of the line", () => {
  const { ui, st, calls } = harness();
  ui.setLineTab(st, "work");
  for (const k of ["scopeDetails", "previewPanel", "plan", "planDetails", "graphDetails", "row"]) assert.equal(st[k].hidden, true, k);
  assert.equal(st.workPane.hidden, false);
  assert.deepEqual(calls, ["work"]);
  ui.renderScopePanel(st);
  assert.equal(st.scopeDetails.hidden, true, "a worker update must not show scope on the Work tab");
});

test("return to Line restores only the panels the line state shows", () => {
  const { ui, st } = harness({ approved: true });
  ui.setLineTab(st, "work"); ui.setLineTab(st, "line");
  assert.equal(st.previewPanel.hidden, true, "no preview selected: no empty preview strip");
  assert.equal(st.plan.hidden, true); assert.equal(st.planDetails.hidden, false);
  assert.equal(st.scopeDetails.hidden, false); assert.equal(st.workPane.hidden, true);
});

test("return to Line re-opens a selected preview through renderGraph", () => {
  const { ui, st } = harness({ preview: true });
  ui.setLineTab(st, "evidence"); assert.equal(st.previewPanel.hidden, true);
  ui.setLineTab(st, "line"); assert.equal(st.previewPanel.hidden, false); assert.equal(st.plan.hidden, false);
});
