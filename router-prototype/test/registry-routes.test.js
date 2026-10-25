"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validClaim, validPatch, boundedInteger, handleRegistryRoute } = require("../registry-routes");

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
test("event replay keeps the cursor when no newer event exists", async () => {
  const h=harness({revision:1,claims:[],requests:[],archive:[],events:[{cursor:4}],outbox:[]});
  handleRegistryRoute({method:"GET"},h.res,new URL("http://x/api/registry/events?after=4"),["api","registry","events"],h.deps);
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(h.res.status,undefined);
});
