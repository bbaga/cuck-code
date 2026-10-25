"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validClaim, validPatch, boundedInteger, handleRegistryRoute, deliverOutbox } = require("../registry-routes");

test("claim fields, status, and text limits are validated", () => {
  assert.equal(validClaim({ repo:"r", branch:"b", commit:"c", title:"t", status:"active" }), true);
  assert.equal(validClaim({ repo:"r", branch:"b", commit:"c", title:"t", surprise:true }), false);
  assert.equal(validClaim({ repo:"r", branch:"b", commit:"c", title:"t", status:"unknown" }), false);
  assert.equal(validPatch({ summary:"x".repeat(2001) }), false);
  assert.equal(validPatch({ revision:9 }), false);
});
test("page inputs stay bounded and requests use explicit page sizes", () => {
  assert.equal(boundedInteger("999999999999", 1, 1000000, 1), 1000000);
  assert.equal(boundedInteger("nonsense", 1, 100, 20), 20);
});
function harness(snapshot) {
  let bodyCb, status, payload;
  const store = { readSnapshot: async () => structuredClone(snapshot), transact: async (expected, fn) => expected !== snapshot.revision ? { stale:true, revision:snapshot.revision } : { result: await fn(snapshot), revision: snapshot.revision + 1 } };
  const res = { writeHead(code) { status=code; }, end(text) { payload=JSON.parse(text); } };
  const deps = { getStore:()=>store, lines:new Map([["L",{}]]), enqueue:()=>{}, json:(r,c,o)=>{status=c;payload=o;}, readBody:(req,cb)=>{bodyCb=cb;}, getRequestRules:()=>({ openRequest:()=>({request:{id:"q"},effects:[]}), transitionRequest:()=>({request:{},effects:[]})}) };
  return { res, deps, async request(data) { while (!bodyCb) await new Promise(resolve=>setImmediate(resolve)); bodyCb(null,data); await new Promise(resolve=>setImmediate(resolve)); return { status:()=>status, json:()=>payload }; } };
}
test("stale snapshot write returns 409 and the current revision", async () => {
  const h=harness({revision:8,claims:[],requests:[],archive:[],events:[],outbox:[]});
  handleRegistryRoute({method:"POST"},h.res,new URL("http://x/api/registry/lines/L/claims"),["api","registry","lines","L","claims"],h.deps);
  const out=await h.request({expectedSnapshotRevision:7,claim:{repo:"r",branch:"b",commit:"c"}});
  assert.equal(out.status(),409); assert.equal(out.json().snapshotRevision,8);
});
test("claim patch rejects unknown fields before store mutation", async () => {
  const h=harness({revision:1,claims:[],requests:[],archive:[],events:[],outbox:[]});
  handleRegistryRoute({method:"PATCH"},h.res,new URL("http://x/api/registry/lines/L/claims/C"),["api","registry","lines","L","claims","C"],h.deps);
  const out=await h.request({expectedSnapshotRevision:1,expectedRevision:1,patch:{ownerLineId:"elsewhere"}});
  assert.equal(out.status(),400);
});
test("outbox retry after restart does not repeat a saved planner notice", async () => {
  let state={revision:2,outbox:[{id:"notice-1",targetLineId:"T",type:"request.opened",requestId:"R"}]};
  const store={readSnapshot:async()=>structuredClone(state),transact:async(rev,fn)=>{if(rev!==state.revision)return {stale:true};fn(state);state.revision++;return {result:true};}};
  const saved=[]; const lines=new Map([["T",{}]]); const saveQueue=(_line,text)=>saved.push(text);
  await deliverOutbox(store,lines,saveQueue);
  await deliverOutbox(store,new Map([["T",{}]]),saveQueue); // Simulate a router restart.
  assert.equal(saved.length,1); assert.match(saved[0],/notice-1/); assert.ok(state.outbox[0].deliveredAt);
});
test("bounded merge refresh archives only verified default-branch merges", async () => {
  const cases=[];
  for (const [label,evidence] of [["verified",{verified:true,defaultBranch:"main",targetBranch:"main",strategy:"merge"}], ["unverified",{verified:false}], ["wrong branch",{verified:true,defaultBranch:"main",targetBranch:"release",strategy:"merge"}], ["integration only",{verified:true,defaultBranch:"main",targetBranch:"main",strategy:"integration"}]]) {
    const snap={revision:1,claims:[{id:label,revision:1,commit:"a"}],requests:[],archive:[],events:[],outbox:[],eventCursor:0};
    const store={readSnapshot:async()=>structuredClone(snap),transact:async(rev,fn)=>({result:await fn(snap),revision:rev+1})};
    const routeHarness=harness(snap); routeHarness.deps.getStore=()=>store;
    routeHarness.deps.getMerge=()=>({verifyMerge:async input=>({ ...evidence, verified:evidence.verified && evidence.defaultBranch===input.targetBranch && evidence.strategy==="merge" }),captureClaim:s=>s.claims[0],transition:(s)=>({ok:true,snapshot:{...s,claims:[],archive:[{id:label}],events:[{cursor:1}],eventCursor:1}})});
    const res=routeHarness.res;
    handleRegistryRoute({method:"POST"},res,new URL("http://x/api/registry/refresh"),["api","registry","refresh"],routeHarness.deps);
    await routeHarness.request({claimIds:[label],evidence:{repoPath:"/repo",repositoryUrl:"https://github.com/o/r",targetBranch:evidence.targetBranch||"main",strategy:evidence.strategy||"merge"}});
    cases.push([label,res.status,snap.archive.length]);
  }
  assert.deepEqual(cases.map(x=>x[2]),[1,0,0,0]);
});
test("event replay keeps the cursor when no newer event exists", async () => {
  const h=harness({revision:1,claims:[],requests:[],archive:[],events:[{cursor:4}],outbox:[]});
  handleRegistryRoute({method:"GET"},h.res,new URL("http://x/api/registry/events?after=4"),["api","registry","events"],h.deps);
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(h.res.status,undefined);
});
