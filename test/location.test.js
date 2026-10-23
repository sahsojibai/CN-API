"use strict";
// Zone parameter discovery: each store's zone parameter is found by testing it, not assumed.
process.env.ALLOW_PRIVATE_HOSTS = "1";
process.env.CHATTRN_SECRET = "test-secret-for-the-suite-only";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../src/server");
const { createMockServer, KEY, PREFIX } = require("../src/mock-store");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function startStack(mockOpts) {
  const mock = createMockServer(mockOpts);
  const mockPort = await listen(mock.server);
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "chattrn-loc-")), publicDir: path.join(__dirname, "..", "public") });
  const port = await listen(app.server);
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const create = async () => (await api("POST", "/api/stores", {
    delivery_mode: "zone",
    name: "Loc store", base_url: `http://127.0.0.1:${mockPort}${PREFIX}`, currency: "BDT",
    auth: { mode: "key", header: "X-API-Key", key: KEY },
  })).body.id;
  const close = () => { mock.server.close(); app.server.close(); };
  return { api, create, close };
}

test("discovery finds zoneId when the store reads zoneId", async () => {
  const s = await startStack({ zoneParam: "zoneId" });
  try {
    const id = await s.create();
    const r = await s.api("POST", `/api/stores/${id}/location/discover`, {});
    assert.equal(r.body.state, "passed");
    assert.equal(r.body.context_param, "zoneId");
    assert.equal(r.body.param_confirmed, true);
    assert.deepEqual(r.body.matched, ["zoneId"]);
  } finally { s.close(); }
});

test("discovery finds zone_id when the store reads zone_id, even though zoneId is tried first", async () => {
  const s = await startStack({ zoneParam: "zone_id" });
  try {
    const id = await s.create();
    const r = await s.api("POST", `/api/stores/${id}/location/discover`, {});
    assert.equal(r.body.state, "passed");
    assert.equal(r.body.context_param, "zone_id");
  } finally { s.close(); }
});

test("discovery finds an unusual name, with a zone-less store", async () => {
  const s = await startStack({ zoneRequired: true, zoneParam: "area_id" });
  try {
    const id = await s.create();
    const r = await s.api("POST", `/api/stores/${id}/location/discover`, {});
    assert.equal(r.body.state, "passed");
    assert.equal(r.body.context_param, "area_id");
  } finally { s.close(); }
});

test("discovery reports when no candidate name works, and keeps the current name", async () => {
  const s = await startStack({ zoneParam: "xyz_unknown" });
  try {
    const id = await s.create();
    const r = await s.api("POST", `/api/stores/${id}/location/discover`, {});
    assert.equal(r.body.state, "needs_attention");
    assert.match(r.body.message, /No zone parameter found/);
    assert.equal(r.body.param_confirmed, false);
    assert.equal(r.body.context_param, null);
  } finally { s.close(); }
});

test("a confirmed name survives a save that keeps the mode, and resets when the mode changes", async () => {
  const s = await startStack({ zoneParam: "zone_id" });
  try {
    const id = await s.create();
    await s.api("POST", `/api/stores/${id}/location/discover`, {});
    const kept = await s.api("PUT", `/api/stores/${id}/delivery-settings`, { mode: "zone", ask_area_when: "when_needed" });
    assert.equal(kept.body.context_param, "zone_id");
    assert.equal(kept.body.param_confirmed, true);
    const changed = await s.api("PUT", `/api/stores/${id}/delivery-settings`, { mode: "outlet", ask_area_when: "when_needed" });
    assert.equal(changed.body.context_param, null);
    assert.equal(changed.body.param_confirmed, false);
  } finally { s.close(); }
});

test("the test connection runs discovery and reports it as a check", async () => {
  const s = await startStack({ zoneParam: "zone_id" });
  try {
    const id = await s.create();
    const run = await s.api("POST", `/api/stores/${id}/test-runs`, {});
    const check = run.body.checks.find((c) => c.label === "Location parameter");
    assert.ok(check, "location check present");
    assert.equal(check.state, "passed");
    assert.equal(check.blocking, false);
  } finally { s.close(); }
});

test("automatic discovery keeps scanning when the first several outlets are empty",async t=>{
  const E=require('../src/endpoints');
  t.mock.method(E,'getJudged',async()=>({body:{zones:Array.from({length:12},(_,id)=>({id:id+1,name:'Outlet '+id}))}}));
  t.mock.method(E,'judgedPath',async(_ctx,_store,opts)=>({res:{http:200},body:{products:opts.context?.name==='outletId' && opts.context.value==='12' ? [{id:1,title:'Rice'}] : []}}));
  const {discoverZoneParam}=require('../src/location');
  const store={base_url:'https://store.test',delivery:{},endpoints:{products:{path:'/products?page=:page'}}};
  const result=await discoverZoneParam({},store);
  assert.equal(result.state,'passed');assert.equal(store.delivery.context_param,'outletId');
  assert.equal(store.delivery.sample_location_id,'12');assert.equal(store.delivery.zone_value,undefined);
});

test("bounded discovery resumes its saved cursor instead of restarting or asking for a location",async t=>{
  const E=require('../src/endpoints');
  let now=Date.now();
  t.mock.method(Date,'now',()=>now);
  t.mock.method(E,'getJudged',async()=>({body:{zones:[{id:'east',name:'East'}]}}));
  const visited=[];
  t.mock.method(E,'judgedPath',async(_ctx,_store,opts)=>{
    if(opts.context){visited.push(opts.context.name);now+=21000;}
    return {res:{http:200},body:{products:opts.context?.name==='zoneId'?[{id:1,title:'Rice'}]:[]}};
  });
  const {discoverZoneParam}=require('../src/location');
  let store={base_url:'https://store.test',delivery:{},endpoints:{products:{path:'/products?page=:page'}}};
  let result;
  for(let i=0;i<20;i++){
    result=await discoverZoneParam({},store);
    if(result.state==='passed')break;
    assert.equal(result.retryable,true);
    store=structuredClone(store);
  }
  assert.equal(result.state,'passed');assert.equal(new Set(visited).size,visited.length);
  assert.equal(store.delivery.context_param,'zoneId');assert.equal(store.delivery.zone_value,undefined);
});
