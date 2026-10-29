"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
const start = html.indexOf("  function workerNode(");
const end = html.indexOf("  function syncTranscriptScroll(", start);
const source = html.slice(start, end);
function harness() {
  const handlers = new WeakMap();
  const graph = { scrollTop: 47, scrollLeft: 63, clientWidth: 900, children: [], set innerHTML(v) { this.children=[]; this.scrollTop=0; this.scrollLeft=0; }, appendChild(x) { this.children.push(x); } };
  const make = () => ({ style:{}, children:[], attrs:{}, append(...xs){this.children.push(...xs);}, appendChild(x){this.children.push(x);}, replaceChildren(...xs){this.children=xs;}, setAttribute(k,v){this.attrs[k]=v;}, addEventListener(type,fn){let h=handlers.get(this)||{}; h[type]=fn;handlers.set(this,h);}, className:"", textContent:"", getAttribute(k){return this.attrs[k];} });
  const document = { createElement: make, createElementNS: (_ns,_tag) => make() };
  const pipelineUI = require("../web/pipeline-ui.js");
  const ui = vm.runInNewContext(source + "\n({ renderGraph, renderGraphContents, selectNode, selectPreview })", { document, SVGNS:"svg", pipelineUI, nodeWidth: pipelineUI.nodeWidth, columnWidth: pipelineUI.columnWidth, workerNode: (st,w,x,y,width)=>{const n=make();n.className="gnode worker"+(st.selected===w.id?" sel":"");n.style={left:x+"px",top:y+"px",width:width+"px"};return n;}, mapPreviewPayload:(_p,w)=>w.kind==="integration"?{eligible:true,availability:"available",steps:[]}:null, previewSelectionKey:id=>`preview:${id}`, sanitizePreviewCommand:x=>x, localStorage:{setItem(){},removeItem(){}}, navigator:{clipboard:{writeText(){}}}, renderTranscript(){}, console });
  function find(node,predicate){if(predicate(node))return node;for(const child of node.children||[]){const found=find(child,predicate);if(found)return found;}return null;}
  function click(node){handlers.get(node).click();}
  return {ui, graph, make, find, click};
}
test("renderGraph restores both offsets after clearing graph content", () => { const {ui,graph}=harness(); const st={graph,workers:new Map(),selected:null}; ui.renderGraph(st); assert.equal(graph.scrollTop,47); assert.equal(graph.scrollLeft,63); });
test("renderGraph preserves zero initial offsets", () => { const {ui,graph}=harness(); graph.scrollTop=graph.scrollLeft=0; ui.renderGraph({graph,workers:new Map(),selected:null}); assert.equal(graph.scrollTop,0); assert.equal(graph.scrollLeft,0); });
test("renderGraph restores offsets and rethrows a rendering failure", () => { const {ui,graph}=harness(); const st={graph,workers:{values(){throw Error("boom")}},selected:null}; assert.throws(()=>ui.renderGraph(st),/boom/); assert.equal(graph.scrollTop,47); assert.equal(graph.scrollLeft,63); });
function state(h, workers) { return { graph:h.graph, workers:new Map(workers.map(w=>[w.id,w])), selected:null, hideFailedValidators:false, plannerStatus:"idle", previewPanel:{hidden:true,replaceChildren(...x){this.children=x;}}, id:"line", tabEvBtn:{}, followTranscript:true }; }
function integration(){return {id:"i",kind:"integration",role:"validator",status:"completed",verdict:"pass",validates:"impl"};}
test("worker and planner clicks select nodes and preserve graph offsets", () => {
  const h=harness(), w={id:"impl",name:"worker",status:"running"}, st=state(h,[w]); h.ui.renderGraph(st);
  const node=h.find(h.graph,n=>(n.className||"").includes("worker")&&(n.className||"").includes("gnode")); assert.ok(node);
  h.click(node); assert.equal(st.selected,"impl"); assert.ok(h.find(h.graph,n=>(n.className||"").includes("sel")&&(n.className||"").includes("worker")));
  assert.equal(h.graph.scrollTop,47); assert.equal(h.graph.scrollLeft,63);
  const planner=h.find(h.graph,n=>(n.className||"").includes("planner")); h.click(planner);
  assert.equal(st.selected,null); assert.equal(h.graph.scrollTop,47); assert.equal(h.graph.scrollLeft,63);
});
test("Preview click executes selection, panel rendering, and graph rendering", () => {
  const h=harness(), iv=integration(), impl={id:"impl",name:"impl",status:"completed"}, st=state(h,[impl,iv]);
  st.previewPayload={eligible:true}; h.ui.renderGraph(st);
  const preview=h.find(h.graph,n=>n.textContent==="Preview"); assert.ok(preview); h.click(preview);
  assert.equal(st.selected,"preview:i"); assert.equal(st.previewPanel.hidden,false);
  assert.equal(h.graph.scrollTop,47); assert.equal(h.graph.scrollLeft,63);
});
test("repeated selection and render cycles do not drift graph offsets", () => {
  const h=harness(), st=state(h,[{id:"impl",name:"impl",status:"running"}]);
  for(let i=0;i<5;i++){h.ui.renderGraph(st);const node=h.find(h.graph,n=>(n.className||"").includes("worker")&&(n.className||"").includes("gnode"));h.click(node);h.ui.selectNode(st,null);assert.equal(h.graph.scrollTop,47);assert.equal(h.graph.scrollLeft,63);}
});
test("validator SVG paths originate at implementor center and route later rows through gutter", () => {
  const h=harness(), impl={id:"impl",name:"impl",status:"completed"};
  const v1={id:"v1",name:"v1",role:"validator",validates:"impl",status:"completed"};
  const v2={id:"v2",name:"v2",role:"validator",validates:"impl",status:"completed"};
  h.ui.renderGraph(state(h,[impl,v1,v2]));
  const paths=[];function visit(n){if(n.attrs&&n.attrs.class==="edge")paths.push(n.attrs.d);for(const c of n.children||[])visit(c);}visit(h.graph);
  const edges=[];function collect(n){if(n.attrs&&n.attrs.class==="edge")edges.push(n);for(const c of n.children||[])collect(c);}collect(h.graph);
  assert.ok(edges.length >= 3, "render includes planner and validator connection paths");
  assert.ok(edges.every(path=>path.attrs.fill==="none"), "every rendered edge path is explicitly unfilled");
  const pipelineUI=require("../web/pipeline-ui.js"), fallback=t=>t.length*8;
  const implEnd=150+pipelineUI.columnWidth([pipelineUI.nodeWidth(impl,fallback)]);
  const valX=implEnd+46;
  const implValidator=edges.map(path=>path.attrs.d).filter(d=>d.startsWith(`M ${implEnd} `));
  assert.equal(implValidator.length,2);
  assert.equal(implValidator[0],`M ${implEnd} 32 H ${implEnd+20} V 32 H ${valX}`);
  assert.equal(implValidator[1],`M ${implEnd} 32 H ${implEnd+22} V 78 H ${valX}`);
});
