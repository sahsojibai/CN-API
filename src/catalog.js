"use strict";
// Catalog sync: reads the product list for every zone (or outlet) and tags each product with the zones it
// appears in. The sync covers the whole store. The zone only matters when a customer asks about a product,
// and then the customer's zone is used to filter the tagged products.
const E = require("./endpoints");
const M = require("./mapping");
const { discoverZoneParam } = require("./location");

// Saves the product field mapping automatically when none is saved yet: reads the product list, matches
// fields by rule, and saves only if every required field matches. The mapping is a rule-based proposal;
// a person can change it in Map fields later.
async function prepareProductMapping(ctx, store) {
  if (M.isSaved(store, "product")) return { ok: true };
  const host = new URL(store.base_url).host;
  const chk = await E.checkEndpoint(ctx, store, "products", {});
  // A zone-less store can report "needs attention" yet still have a sample read with its first zone.
  const sample = M.sampleFor(store, "product");
  if (!sample) return { ok: false, message: `Product list: ${chk.message || chk.summary || "no products could be read"}` };
  const proposal = M.propose("product", sample);
  const rows = proposal.rows.map((r) => ({
    key: r.key,
    source_path: r.source_path,
    state: r.state,
    not_in_store: r.key === "updated_at" || undefined,
  }));
  try {
    const { rows: saved, extras } = M.normaliseRows(store, "product", rows, []);
    M.saveVersion(store, "product", saved, extras);
    return { ok: true, host };
  } catch (e) {
    return { ok: false, message: `Field mapping: ${e.message}` };
  }
}

async function syncCatalog(ctx, store, { deadline = Infinity } = {}) {
  const host = new URL(store.base_url).host;
  const mapped = await prepareProductMapping(ctx, store);
  if (!mapped.ok) return { ok: false, message: mapped.message };
  if (!store.delivery?.context_param || !store.delivery?.param_confirmed) {
    const d = await discoverZoneParam(ctx, store, { host });
    if (d.state !== "passed") return { ok: false, message: `The zone parameter isn't confirmed for this store. ${d.message}` };
  }
  const z = await E.getJudged(ctx, store, "zones", {}, null, host);
  if (z.bad) return { ok: false, message: `Could not read the zone list: ${z.bad.message}` };
  const zones = M.zonesOf(store, M.extractList(z.body) || []);
  if (!zones.length) return { ok: false, message: "The zone list is empty, so there is nothing to sync." };

  const param = store.delivery.context_param;
  const byId = new Map();
  const perZone = [];
  for (const zone of zones) {
    if (Date.now() > deadline) { perZone.push({ zone: String(zone.id), skipped: "time limit" }); continue; }
    const zid = String(zone.id);
    const walk = await E.walkProducts(ctx, store, { context: { name: param, value: zid }, host, maxPages: 40, deadline });
    if (walk.error) { perZone.push({ zone: zid, error: walk.error.message }); continue; }
    let count = 0;
    for (const page of walk.pages) {
      for (const raw of page) {
        if (!M.isObj(raw)) continue;
        const p = M.toProduct(store, raw);
        if (p.id == null) continue;
        let entry = byId.get(p.id);
        if (!entry) { entry = { product: p, zones: [] }; byId.set(p.id, entry); }
        if (!entry.zones.includes(zid)) entry.zones.push(zid);
        count++;
      }
    }
    perZone.push({ zone: zid, name: zone.name, products: count, capped: !!walk.capped });
  }

  store.catalog = {
    synced_at: new Date().toISOString(),
    zone_param: param,
    zones_checked: zones.length,
    products: [...byId.values()],
  };
  return {
    ok: true,
    zones_checked: zones.length,
    products_total: byId.size,
    per_zone: perZone,
    synced_at: store.catalog.synced_at,
  };
}

// Products a customer in this zone can be offered, from the last sync.
function catalogFor(store, zoneId) {
  if (!store.catalog) return null;
  const zid = zoneId == null ? null : String(zoneId);
  const items = store.catalog.products.filter((e) => zid == null || e.zones.includes(zid));
  return items.map((e) => ({ ...e.product, zones: e.zones }));
}

module.exports = { syncCatalog, catalogFor, prepareProductMapping };
