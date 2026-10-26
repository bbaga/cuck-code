"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
const start = html.indexOf("  function workerNode(");
const end = html.indexOf("  function selectPreview(", start);
const source = html.slice(start, end);
function harness() {
  const graph = { scrollTop: 47, scrollLeft: 63, clientWidth: 900, children: [], set innerHTML(v) { this.children=[]; this.scrollTop=0; this.scrollLeft=0; }, appendChild(x) { this.children.push(x); } };
  const make = () => ({ style:{}, children:[], attrs:{}, append(...xs){this.children.push(...xs);}, appendChild(x){this.children.push(x);}, setAttribute(k,v){this.attrs[k]=v;}, addEventListener(){}, className:"", textContent:"" });
  const document = { createElement: make, createElementNS: (_ns,_tag) => make() };
  const ui = vm.runInNewContext(source + "\n({ renderGraph, renderGraphContents })", { document, SVGNS:"svg", pipelineUI:{buildGraphLanes: workers => ({lanes:[],orphans:[],integrations:[],totalRows:0})}, workerNode:()=>make(), mapPreviewPayload:()=>null, previewSelectionKey:id=>`preview:${id}`, renderPreviewPanel(){}, localStorage:{setItem(){},removeItem(){}}, renderTranscript(){}, console });
  return {ui, graph};
}
test("renderGraph restores both offsets after clearing graph content", () => { const {ui,graph}=harness(); const st={graph,workers:new Map(),selected:null}; ui.renderGraph(st); assert.equal(graph.scrollTop,47); assert.equal(graph.scrollLeft,63); });
test("renderGraph preserves zero initial offsets", () => { const {ui,graph}=harness(); graph.scrollTop=graph.scrollLeft=0; ui.renderGraph({graph,workers:new Map(),selected:null}); assert.equal(graph.scrollTop,0); assert.equal(graph.scrollLeft,0); });
test("renderGraph restores offsets and rethrows a rendering failure", () => { const {ui,graph}=harness(); const st={graph,workers:{values(){throw Error("boom")}},selected:null}; assert.throws(()=>ui.renderGraph(st),/boom/); assert.equal(graph.scrollTop,47); assert.equal(graph.scrollLeft,63); });
test("worker and planner selection call the same scroll-preserving wrapper", () => { assert.match(html,/function selectNode\(st, id\)[\s\S]*?renderGraph\(st\)/); assert.match(html,/pn\.addEventListener\("click", \(\) => selectNode\(st, null\)\)/); assert.match(html,/n\.addEventListener\("click", \(\) => selectNode\(st, w\.id\)\)/); });
test("Preview selection is wired to renderGraph", () => { assert.match(source,/function renderGraph\(st\)/); assert.match(html,/function selectPreview[\s\S]*?renderPreviewPanel\(st, worker, data\)/); assert.match(html,/st\.previewPanel\.replaceChildren\(panel\); st\.previewPanel\.hidden = false; renderGraph\(st\)/); });
