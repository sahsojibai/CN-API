"use strict";
const { randomUUID } = require("node:crypto");
const { advanceSync, beginSync } = require("./catalog");

function createCatalogJobs(ctx) {
  const owner = randomUUID();
  let stopped = false, running = false, timer;
  async function tick() {
    if (stopped || running) return;
    running = true;
    let active = false;
    try {
      const ids = await ctx.db.pendingCatalogJobs();
      active = ids.length > 0;
      // One writer per store. PostgreSQL revisions arbitrate leases across app instances.
      for (const id of ids.slice(0, 5)) {
        if (stopped) break;
        let store = await ctx.db.find(id);
        if (store && store.status === "connected" && (!store.catalog_sync ||
          (store.catalog_sync.status === "complete" && Date.parse(store.catalog_sync.next_sync_at) <= Date.now()) ||
          (store.catalog_sync.phase === "prepare" && store.catalog_sync.status === "queued"))) {
          try { await beginSync(ctx, store, {refresh:true}); }
          catch (error) { store.catalog_sync = {id:randomUUID(),status:error.retryable ? "queued" : "partial",phase:"prepare",error:error.message,locations_done:0,pages_read:0,per_location:[]}; }
          try { await ctx.db.put(store, {catalog:true}); } catch(error) { if(error.code === "store_changed") continue; throw error; }
          if (store.catalog_sync.phase === "prepare") continue;
        }
        const job = store?.catalog_sync;
        if (!job || !["queued", "running"].includes(job.status)) continue;
        if (job.next_attempt_at && Date.parse(job.next_attempt_at) > Date.now()) continue;
        if (job.lease_owner && job.lease_owner !== owner && Date.parse(job.lease_until) > Date.now()) continue;
        job.lease_owner = owner;
        job.lease_until = new Date(Date.now() + 120000).toISOString();
        try { await ctx.db.putCatalog(store); } catch (error) { if (error.code === "store_changed") continue; throw error; }
        await advanceSync(ctx, store);
        if (stopped) break;
        store.catalog_sync.lease_owner = null; store.catalog_sync.lease_until = null;
        try { await ctx.db.putCatalog(store); } catch (error) { if (error.code !== "store_changed") throw error; }
      }
    } catch (error) { console.warn("Catalog worker checkpoint failed", error.code || error.name); }
    finally {
      running = false;
      if (!stopped) { timer = setTimeout(tick, active ? 10 : 5000); timer.unref(); }
    }
  }
  return {
    start() { stopped = false; tick(); },
    stop() { stopped = true; clearTimeout(timer); },
    wake() { if (!stopped) { clearTimeout(timer); tick(); } },
  };
}
module.exports = { createCatalogJobs };
