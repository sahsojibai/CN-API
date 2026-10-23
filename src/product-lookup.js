"use strict";
const E = require("./endpoints");
const M = require("./mapping");
const C = require("./chattrn-connector");
const S = require("./catalog-source");
const { catalogFor, syncStatus } = require("./catalog");
const { HttpError } = require("./http");

async function lookupProducts(ctx, store, input = {}) {
  const catalog = store.catalog_build || store.catalog;
  if (!catalog) return { products: [], sync: syncStatus(store), complete: false, message: "The whole-store catalog is still being prepared. No complete absence result is available yet." };
  if (store.catalog_sync?.configuration_stamp && store.catalog_sync.configuration_stamp !== require("./onboarding").configurationStamp(store)) {
    throw new HttpError(409, "catalog_stale", "Connection mappings changed. Restart the catalog sync before looking up products.");
  }
  let location = input.location_id ?? input.zone;
  if (!location && input.area) {
    const area = String(input.area).trim().toLowerCase();
    const matches = (catalog.locations || []).filter(l => l.name.toLowerCase() === area || l.id === area);
    if (matches.length === 1) location = matches[0].id;
    else if (S.native(store)) {
      const result = await C.resolveArea(ctx, store, input.area);
      if (result.res.http === 200 && result.resolution?.location_id != null) location = String(result.resolution.location_id);
    }
  }
  if (location == null && catalog.locations?.length === 1) location = catalog.locations[0].id;
  if (location != null && !(catalog.locations || []).some(l => l.id === String(location))) {
    throw new HttpError(422, "unknown_location", "Choose a location returned by this store's location list.");
  }
  const query = String(input.query || "").slice(0,300).toLowerCase().trim();
  const stop = new Set(["do","you","have","what","price","stock","available","availability","please","is","the","of","for","in","at","can","show","me","about","and","a","an","which","how","much","দাম","কত","আছে","কি"]);
  const words = query.split(/[^\p{L}\p{N}]+/u).filter(word => word && !stop.has(word)).slice(0,12);
  // Search the union first; the customer's location is applied only to live offers.
  let products = catalogFor(store, null).map(product => {
    const text = [product.id, product.title, product.vendor, product.description].join(" ").toLowerCase();
    return { product, score: words.filter(word => text.includes(word)).length };
  }).filter(match => !query || match.score > 0).sort((a,b) => b.score - a.score).map(match => match.product);
  const total = products.length;
  products = products.slice(0, Math.min(10, Math.max(1, Number(input.limit) || 10)));
  const required = !!catalog.location_required && location == null;
  if (location != null) {
    const live = [];
    const deadline = Date.now() + 20000;
    for (const product of products) {
      if (Date.now() > deadline) throw new HttpError(503, "lookup_timeout", "Live lookup reached its time limit. Try a more specific product query.");
      if (S.native(store)) {
        const result = await C.getProduct(ctx, store, product.id);
        if (result.res.http !== 200 || result.res.error || !result.body) throw new HttpError(502, "live_lookup_failed", "Could not confirm the product's live information. Try again; cached stock was not used.");
        const normalized = C.toProduct(result.body, store.currency);
        if (store.chattrn?.capabilities?.inventory_levels || store.catalog_sync?.plan?.inventory) {
          try { live.push(...await S.nativeOffers(ctx, store, [normalized], { id: String(location) }, {deadline})); }
          catch { throw new HttpError(502, "live_lookup_failed", "Location inventory could not be confirmed. Try again; cached stock was not used."); }
        } else live.push({ ...normalized, stock: catalog.location_required ? null : normalized.stock,
          variants: normalized.variants.map(v => ({ ...v, stock: catalog.location_required ? null : v.stock })) });
      } else {
        if (!catalog.zone_param && catalog.location_required) throw new HttpError(409, "location_mapping_required", "Location-specific offers are not configured for this API yet.");
        const result = await E.judgedPath(ctx, store, { path: E.fillPath(E.configOf(store, "detail").path, { id: product.id }),
          context: catalog.zone_param ? { name: catalog.zone_param, value: String(location) } : null, useContext: !!catalog.zone_param });
        if (result.bad) throw new HttpError(502, "live_lookup_failed", result.bad.message);
        const normalized = M.toProduct(store, M.unwrapOne(result.body));
        if (normalized.id !== product.id) throw new HttpError(502, "live_lookup_failed", "The store returned another product. Live information could not be confirmed.");
        live.push(normalized);
      }
    }
    products = live.map(p => ({ ...p, location_id: String(location), observed_at: new Date().toISOString(), source: "live" }));
  }
  return { count: total, products, location_id: location == null ? null : String(location), location_required: required,
    question: required ? "Which delivery zone or outlet should I check price and availability for?" : null,
    complete: !!catalog.complete, sync: syncStatus(store),
    message: !catalog.complete ? "Catalog import is incomplete. More products may still be added." : null };
}
module.exports = { lookupProducts };
