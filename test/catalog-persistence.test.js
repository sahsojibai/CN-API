"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { PostgresDb } = require("../src/postgres-db");

test("catalog leases arbitrate across processes without overwriting concurrent merchant edits", {skip:!process.env.TEST_DATABASE_URL},async()=>{
  const a = await new PostgresDb(process.env.TEST_DATABASE_URL).init();
  const b = await new PostgresDb(process.env.TEST_DATABASE_URL).init();
  const id = randomUUID();
  try {
    await a.put({id,name:"Before",status:"draft",catalog_sync:{id:"job",status:"queued",pages_read:0},catalog_build:{products:[]}}, {catalog:true});
    const edit = await a.find(id);
    const one = await a.find(id), two = await b.find(id);
    one.catalog_sync.lease_owner="a";two.catalog_sync.lease_owner="b";
    const winners=await Promise.allSettled([a.putCatalog(one),b.putCatalog(two)]);
    assert.equal(winners.filter(w=>w.status==="fulfilled").length,1);
    const worker = await b.find(id);worker.catalog_sync.pages_read=5;worker.catalog_build.products=Array.from({length:100},(_,id)=>({product:{id,title:"Product"},zones:[],offers:{}}));await b.putCatalog(worker);
    const summary=(await b.list()).find(store=>store.id===id);
    assert.equal(summary.catalog_sync.products_total,100);
    assert.equal(summary.catalog_build,undefined,"store lists exclude bulk import data");
    edit.name="Merchant edit during import";await a.put(edit);
    assert.equal((await a.find(id)).catalog_sync.pages_read,5,"merchant write preserves the latest import checkpoint");
    worker.catalog_sync.pages_read=6;
    await assert.rejects(b.putCatalog(worker),e=>e.code==="store_changed","old checkpoint cannot overwrite a newer merchant revision");
    assert.equal((await b.find(id)).name,"Merchant edit during import");
    await a.close();
    const fresh=await new PostgresDb(process.env.TEST_DATABASE_URL).init();
    try{assert.equal((await fresh.find(id)).catalog_sync.pages_read,5);assert.ok((await fresh.pendingCatalogJobs()).includes(id));}finally{await fresh.close();}
  }finally{await b.pool.query("DELETE FROM chattrn_stores WHERE id=$1",[id]);await Promise.allSettled([a.close(),b.close()]);}
});
