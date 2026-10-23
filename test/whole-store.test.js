"use strict";
process.env.ALLOW_PRIVATE_HOSTS = "1";
const test = require("node:test"), assert = require("node:assert/strict");
const http = require("node:http"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createApp } = require("../src/server");
const { Db } = require("../src/db");
const { beginSync, advanceSync, catalogFor, syncStatus } = require("../src/catalog");
const Source = require("../src/catalog-source");
const { createMockChattrnStore } = require("../src/mock-chattrn-store");
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); };

function merchant({ missingStatus = 200 } = {}) {
  let fail = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const zone = url.searchParams.get("outletId");
    res.setHeader("Content-Type", "application/json");
    const send = (body, status = 200) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    const product = (id, title) => ({ id, title, description:"Shared product description", price:zone === "east" ? "10.00" : "20.00", stock:zone === "east" ? 0 : 8 });
    if (url.pathname === "/delivery-zone") return send({zones:[{id:"empty",name:"Empty outlet"},{id:"east",name:"East"},{id:"west",name:"West"}]});
    if (url.pathname === "/products") {
      if (!zone || zone === "empty") return send({products:[]}, !zone ? missingStatus : 200);
      if (fail && zone === "west") return send({error:"temporary outage"},503);
      const page = Number(url.searchParams.get("page") || 1);
      return send({ products: page > 1 ? [] : [product(1,"Rice"), product(zone === "east" ? 2 : 3, zone === "east" ? "East fruit" : "West fruit")] });
    }
    if (url.pathname.startsWith("/products/")) {
      if (fail) return send({error:"unavailable"},503);
      return send({product: product(Number(url.pathname.split("/").pop()),"Rice")});
    }
    send({},404);
  });
  return {server, fail(value) {fail = value;}};
}

async function stack(options) {
  const shop = merchant(options), merchantBase = await listen(shop.server);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whole-store-"));
  const app = createApp({dataDir:dir, publicDir:path.join(__dirname,"../public"), adminToken:""});
  const base = await listen(app.server);
  const api = async (method, route, body) => {
    const response = await fetch(base + route,{method,headers:{"Content-Type":"application/json"},body:body && JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  const created = await api("POST","/api/stores",{name:"All outlets",brand:"Brand A",connection_type:"mapped_api",delivery_mode:"outlet",base_url:merchantBase,currency:"BDT"});
  assert.equal(created.status,201);
  return {app,shop,dir,api,id:created.body.id,async close(){await close(app.server);await close(shop.server);fs.rmSync(dir,{recursive:true,force:true});}};
}

async function poll(api,id) {
  for (let tries=0; tries<180; tries++) {
    const status = (await api("GET",`/api/stores/${id}/catalog/status`)).body;
    if (["complete","partial","stale"].includes(status.status)) return status;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error("Import did not finish");
}

test("automatic setup bypasses an empty first outlet; background import covers every outlet and preserves offers", async () => {
  const s = await stack();
  try {
    const checked = await s.api("POST",`/api/stores/${s.id}/endpoints/products/check`,{});
    assert.equal(checked.body.state,"responded",JSON.stringify(checked.body));
    assert.equal(s.app.db.find(s.id).delivery.zone_value,null,"no merchant location chosen");
    const start = await s.api("POST",`/api/stores/${s.id}/catalog/sync`,{});
    assert.equal(start.status,202);
    const final = await poll(s.api,s.id);
    assert.equal(final.status,"complete",JSON.stringify(final));
    assert.equal(final.locations_done,3); assert.equal(final.products_total,3);
    const all = (await s.api("GET",`/api/stores/${s.id}/catalog`)).body;
    assert.equal(all.count,3); assert.equal(all.complete,true);
    assert.equal(all.products.find(p=>p.id==="1").price,null);
    assert.ok(all.products.every(p=>p.stock===null));
    const east = (await s.api("GET",`/api/stores/${s.id}/catalog?zone=east`)).body.products.find(p=>p.id==="1");
    const west = (await s.api("GET",`/api/stores/${s.id}/catalog?zone=west`)).body.products.find(p=>p.id==="1");
    assert.equal(east.price,"10.00"); assert.equal(east.stock,0);
    assert.equal(west.price,"20.00"); assert.equal(west.stock,8);
    const generic = (await s.api("POST",`/api/stores/${s.id}/product-lookup`,{query:"Do you have rice?"})).body;
    assert.equal(generic.location_required,true); assert.match(generic.question,/zone or outlet/);
    assert.equal(generic.products[0].description,"Shared product description");
    const live = (await s.api("POST",`/api/stores/${s.id}/product-lookup`,{query:"Rice",area:"West"})).body;
    assert.equal(live.location_id,"west"); assert.equal(live.products[0].stock,8); assert.equal(live.products[0].source,"live");
    assert.equal((await s.api("POST",`/api/stores/${s.id}/product-lookup`,{query:"Rice",location_id:"invented"})).status,422);
    s.shop.fail(true);
    assert.equal((await s.api("POST",`/api/stores/${s.id}/product-lookup`,{query:"Rice",location_id:"west"})).status,502,"no cached-stock fallback");
  } finally {await s.close();}
});

test("checkpoint survives restart; failed locations remain partial and resume without losing successful offers", async () => {
  const s = await stack(); s.app.catalogJobs.stop();
  try {
    let store = s.app.db.find(s.id);
    await beginSync(s.app.ctx,store); s.app.db.put(store,{catalog:true});
    await advanceSync(s.app.ctx,store); s.app.db.putCatalog(store);
    const restored = new Db(path.join(s.dir,"stores.json"));
    store = restored.find(s.id); const originalJob = store.catalog_sync.id;
    s.shop.fail(true);
    for(let i=0;i<20 && store.catalog_sync.status!=="partial";i++){await advanceSync(s.app.ctx,store);restored.putCatalog(store);}
    assert.equal(store.catalog_sync.status,"partial");
    assert.equal(store.catalog_sync.id,originalJob);
    assert.equal(syncStatus(store).complete,false);
    assert.equal(catalogFor(store).length,2);
    assert.equal(store.catalog,undefined,"partial data not promoted to complete");
    s.shop.fail(false); await beginSync(s.app.ctx,store,{retry:true}); restored.put(store,{catalog:true});
    for(let i=0;i<10 && store.catalog_sync.status!=="complete";i++){await advanceSync(s.app.ctx,store);restored.putCatalog(store);}
    assert.equal(store.catalog_sync.status,"complete"); assert.equal(store.catalog_sync.id,originalJob);
    assert.equal(catalogFor(store).length,3);
    assert.equal(catalogFor(store,"east").find(p=>p.id==="1").stock,0);
    assert.equal(catalogFor(store,"west").find(p=>p.id==="1").stock,8);
    await beginSync(s.app.ctx,store);restored.put(store,{catalog:true});
    store.base_url += "/changed"; await advanceSync(s.app.ctx,store);
    assert.equal(store.catalog_sync.status,"stale");
  } finally {await s.close();}
});

for (const type of ["chattrn_api","laravel_package"]) test(`${type}: one global catalog plus separate inventory at every location`,async () => {
  const shop = createMockChattrnStore(), site = await listen(shop.server);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"whole-native-"));
  const app = createApp({dataDir:dir,publicDir:path.join(__dirname,"../public"),adminToken:""});
  try {
    const {encrypt}=require("../src/crypto");
    const store = {id:type,name:type,connection_type:type,status:"draft",currency:"BDT",delivery:{mode:"zone"},
      chattrn:{base_url:site+shop.PREFIX,access_token_enc:encrypt(shop.TOKEN,app.ctx.secretKey)}};
    app.db.put(store); await beginSync(app.ctx,store);app.db.put(store,{catalog:true});
    for(let i=0;i<30 && store.catalog_sync.status!=="complete";i++){await advanceSync(app.ctx,store);app.db.putCatalog(store);}
    assert.equal(store.catalog_sync.status,"complete",JSON.stringify(syncStatus(store)));
    assert.equal(store.catalog.products.length,60);
    assert.equal(store.catalog_sync.locations_done,2);
    assert.equal(catalogFor(store).find(p=>p.id==="632900001").stock,null);
    assert.equal(catalogFor(store,"900001").find(p=>p.id==="632900001").stock,7);
    assert.equal(catalogFor(store,"900002").find(p=>p.id==="632900001").stock,4);
  }finally{app.catalogJobs.stop();await close(shop.server);fs.rmSync(dir,{recursive:true,force:true});}
});

test("missing native location inventory stays unknown and never inherits global stock",async t=>{
  const C=require("../src/chattrn-connector");
  t.mock.method(C,"inventoryLevels",async()=>({res:{http:200},list:[]}));
  const products=await Source.nativeOffers({}, {chattrn:{capabilities:{location_prices:true}}},[{id:"1",variants:[{id:"v",inventory_item_id:"i",price:"10.00",stock:999}]}],{id:"west"});
  assert.equal(products[0].stock,null);assert.equal(products[0].variants[0].stock,null);
  assert.equal(products[0].price,null,"a missing location price never inherits a primary-location price");
});

for (const paging of ["page","link","cursor","offset"]) test(`whole-store paging supports ${paging} without inheriting the diagnostic sample location`, async () => {
  const {createMockServer,KEY,PREFIX}=require("../src/mock-store");
  const mock=createMockServer({paging}), base=await listen(mock.server);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"global-pages-"));
  const app=createApp({dataDir:dir,publicDir:path.join(__dirname,"../public"),adminToken:""});
  try {
    const {encrypt}=require("../src/crypto");
    const store={base_url:base+PREFIX,auth:{mode:"key",header:"X-API-Key",secret_enc:encrypt(KEY,app.ctx.secretKey)},delivery:{context_param:"zoneId",sample_location_id:"100"}};
    let cursor={},count=0;
    for(let i=0;i<35;i++){
      const page=await Source.readPage(app.ctx,store,{scope:"global",adapter:"mapped"},null,cursor);
      count+=page.raw.length;cursor=page.cursor;if(page.done)break;
    }
    assert.equal(count,600);
    assert.ok(mock.requests.filter(r=>r.path.includes("/products")).every(r=>!r.search.includes("zoneId=")));
  }finally{app.catalogJobs.stop();await close(mock.server);fs.rmSync(dir,{recursive:true,force:true});}
});

test("an API that requires a location with HTTP 422 is sampled automatically",async()=>{
  const s=await stack({missingStatus:422});
  try{
    const response=await s.api("POST",`/api/stores/${s.id}/endpoints/products/check`,{});
    assert.equal(response.body.state,"responded",JSON.stringify(response.body));
    assert.equal(s.app.db.find(s.id).delivery.zone_value,null);
  }finally{await s.close();}
});

test("legacy catalogs cannot expose a sampled location's offer as a global price",()=>{
  const products=catalogFor({catalog:{zone_param:"zoneId",products:[{product:{id:"1",title:"Rice",price:"10.00",stock:999,variants:[]},zones:["east"]}]}});
  assert.equal(products[0].price,null);assert.equal(products[0].stock,null);assert.equal(products[0].location_required,true);
});

test("native repeated pages and incomplete advertised counts cannot report a complete import",async t=>{
  const C=require("../src/chattrn-connector");
  t.mock.method(C,"listProducts",async()=>({res:{http:200},list:[{id:1,title:"Rice",variants:[]}],next:"https://store.test/products.json?page_info=2"}));
  const first=await Source.readPage({}, {connection_type:"chattrn_api"},{adapter:"native"},null,{});
  await assert.rejects(Source.readPage({}, {connection_type:"chattrn_api"},{adapter:"native"},null,first.cursor),/repeated/);
  const store={connection_type:"chattrn_api",catalog_sync:{id:"job",status:"running",phase:"finish",plan:{expected_products:2,locations:[]},attempts:0},catalog_build:{products:[{product:{id:"1"}}]}};
  store.catalog_sync.configuration_stamp=require("../src/onboarding").configurationStamp(store);
  for(let i=0;i<3;i++)await advanceSync({},store);
  assert.equal(store.catalog_sync.status,"partial");assert.equal(store.catalog,undefined);
  assert.match(store.catalog_sync.error,/count differs/);
});

test("existing connected stores bootstrap a whole-store import and due refreshes run without re-pairing",async()=>{
  const s=await stack();
  try{
    const store=s.app.db.find(s.id);store.status="connected";s.app.db.put(store);s.app.catalogJobs.wake();
    let final;
    for(let i=0;i<200;i++){
      final=syncStatus(s.app.db.find(s.id));
      if(final.status==="complete")break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(final.status,"complete",JSON.stringify(final));
    const oldId=final.id;
    const due=s.app.db.find(s.id);due.catalog_sync.next_sync_at=new Date(Date.now()-1000).toISOString();s.app.db.put(due,{catalog:true});
    s.app.catalogJobs.wake();
    for(let i=0;i<200;i++){
      final=syncStatus(s.app.db.find(s.id));
      if(final.id!==oldId && final.status==="complete")break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.notEqual(final.id,oldId);assert.equal(final.status,"complete");assert.equal(final.products_total,3);
  }finally{await s.close();}
});
