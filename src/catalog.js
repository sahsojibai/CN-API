"use strict";
const { randomUUID } = require("node:crypto");
const M = require("./mapping");
const E = require("./endpoints");
const { HttpError } = require("./http");
const S = require("./catalog-source");
const { configurationStamp } = require("./onboarding");

async function prepareProductMapping(ctx, store) {
  if (S.native(store) || M.isSaved(store, "product")) return { ok: true };
  const check = await E.checkEndpoint(ctx, store, "products", {});
  const sample = M.sampleFor(store, "product");
  if (!sample) return { ok: false, message: check.message || check.summary || "No product samples found.", retryable: !!check.retryable };
  try {
    const proposal = M.propose("product", sample);
    const input = proposal.rows.map(r => ({ key: r.key, source_path: r.source_path, state: r.state, not_in_store: r.key === "updated_at" }));
    const { rows, extras } = M.normaliseRows(store, "product", input, []);
    M.saveVersion(store, "product", rows, extras);
    return { ok: true };
  } catch (error) { return { ok: false, message: error.message }; }
}

function neutralProduct(product) {
  return { ...product, price: null, compare_at_price: null, stock: null,
    variants: (product.variants || []).map(v => ({ ...v, price: null, compare_at_price: null, stock: null })) };
}

function mergeProducts(catalog, products, location) {
  const byId = new Map(catalog.products.map(entry => [String(entry.product.id), entry]));
  for (const product of products) {
    if (product?.id == null || !product.title) throw new Error("A product is missing its mapped ID or title.");
    const id = String(product.id);
    let entry = byId.get(id);
    if (!entry) { entry = { product: { ...product, id }, zones: [], offers: {} }; byId.set(id, entry); }
    else {
      const variants = new Map(entry.product.variants.map(v => [String(v.id), v]));
      for (const variant of product.variants) if (!variants.has(String(variant.id))) variants.set(String(variant.id), variant);
      entry.product.variants = [...variants.values()];
    }
    if (location) {
      if (!entry.zones.includes(location.id)) entry.zones.push(location.id);
      entry.offers[location.id] = { price: product.price, compare_at_price: product.compare_at_price,
        stock: product.stock, currency: product.currency, variants: product.variants, observed_at: new Date().toISOString() };
    }
  }
  if (byId.size > 100000) throw new Error("Catalog exceeds the current 100,000-product import limit. Import is incomplete.");
  catalog.products = [...byId.values()];
  if (Buffer.byteLength(JSON.stringify(catalog)) > 32 * 1024 * 1024) throw new Error("Catalog exceeds the current 32 MB snapshot limit. Import is incomplete.");
}

async function beginSync(ctx, store, { retry = false, refresh = false } = {}) {
  const current = store.catalog_sync;
  if (!refresh && current?.status === "complete" && current.configuration_stamp === configurationStamp(store)) return current;
  if (current && ["queued", "running"].includes(current.status) && current.configuration_stamp === configurationStamp(store)) return current;
  if (retry && current && current.configuration_stamp === configurationStamp(store) && current.status === "partial" && !["prepare","finish"].includes(current.phase)) {
    current.status = "queued"; current.attempts = 0; current.next_attempt_at = null; current.error = null;
    current.lease_owner = null; current.lease_until = null;
    return current;
  }
  const mapping = await prepareProductMapping(ctx, store);
  if (!mapping.ok) throw Object.assign(new Error(mapping.message), {retryable: !!mapping.retryable});
  store.catalog_sync = { id: randomUUID(), status: "queued", started_at: new Date().toISOString(),
    configuration_stamp: configurationStamp(store), phase: "discover", locations_done: 0, pages_read: 0,
    attempts: 0, location_index: 0, inventory_offset: 0, cursor: {}, per_location: [] };
  // Keep the previous complete catalog intact until a replacement import succeeds.
  store.catalog_build = { products: [], complete: false };
  return store.catalog_sync;
}

// One resumable checkpoint: discovery, a product page, or one location's inventory batch.
async function advanceSync(ctx, store) {
  const job = store.catalog_sync;
  if (job.configuration_stamp !== configurationStamp(store)) { job.status = "stale"; job.error = "Connection or mappings changed. Start a new catalog sync."; return; }
  job.status = "running";
  try {
    if (job.phase === "discover") {
      if (job.discovery_probe) store.delivery = {...store.delivery,location_probe:job.discovery_probe};
      job.plan = await S.discoverCatalog(ctx, store);
      delete job.discovery_probe;
      job.phase = "products";
      store.catalog_build = { products: [], complete: false, location_required: job.plan.location_required,
        zone_param: job.plan.param || null, locations: job.plan.locations, scope: job.plan.scope };
    } else if (job.phase === "products") {
      const locations = job.plan.scope === "locations" ? job.plan.locations : [null];
      const location = locations[job.location_index];
      const page = await S.readPage(ctx, store, job.plan, location, job.cursor);
      mergeProducts(store.catalog_build, page.products, location);
      job.pages_read++;
      if (job.pages_read > 10000) throw new Error("Catalog exceeded 10,000 pages. Import is incomplete.");
      job.cursor = page.cursor;
      if (page.done) {
        job.per_location.push({ id: location?.id || "global", state: "complete" });
        job.location_index++; job.cursor = {};
        if (job.plan.scope === "locations") job.locations_done++;
        if (job.location_index >= locations.length) {
          if (job.plan.adapter === "native" && job.plan.inventory && job.plan.locations.length) {
            job.phase = "inventory"; job.location_index = 0;
          } else job.phase = "finish";
        }
      }
    } else if (job.phase === "inventory") {
      const location = job.plan.locations[job.location_index];
      const products = store.catalog_build.products.slice(job.inventory_offset, job.inventory_offset + 20).map(entry => entry.product);
      const offers = await S.nativeOffers(ctx, store, products, location);
      mergeProducts(store.catalog_build, offers, location);
      job.inventory_offset += products.length;
      if (job.inventory_offset >= store.catalog_build.products.length) {
        job.per_location.push({ id: location.id, state: "complete" });
        job.locations_done++; job.location_index++; job.inventory_offset = 0;
        if (job.location_index >= job.plan.locations.length) job.phase = "finish";
      }
    }
    if (job.phase === "finish") {
      if (!store.catalog_build.products.length) throw new Error("No products were imported. Check mappings and API permissions.");
      if (job.plan.expected_products != null && store.catalog_build.products.length !== job.plan.expected_products) {
        throw new Error("Imported product count differs from the store count. Retry a fresh whole-store import.");
      }
      if (job.plan.offers_unavailable) throw new Error("Global catalog imported, but location-specific offers could not be verified. Check the location parameter mapping.");
      store.catalog = { ...store.catalog_build, complete: true, configuration_stamp: job.configuration_stamp,
        synced_at: new Date().toISOString(), zones_checked: job.plan.locations.length };
      delete store.catalog_build;
      job.status = "complete"; job.finished_at = store.catalog.synced_at;
      job.next_sync_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    }
    job.attempts = 0; job.error = null; job.next_attempt_at = null;
  } catch (error) {
    if (error.retryable) {
      job.discovery_probe = store.delivery?.location_probe;
      job.status = "queued"; job.error = error.message;
      return;
    }
    job.attempts++;
    job.error = error.message;
    job.status = job.attempts >= 3 ? "partial" : "queued";
    job.next_attempt_at = new Date(Date.now() + Math.min(30000, 1000 * 2 ** job.attempts)).toISOString();
  }
}

function syncStatus(store) {
  const job = store.catalog_sync;
  if (!job) return { status: "not_started", complete: false, products_total: store.catalog?.products?.length || 0 };
  const stale = job.configuration_stamp && job.configuration_stamp !== configurationStamp(store);
  return { id: job.id, status: stale ? "stale" : job.status, complete: !stale && job.status === "complete", phase: job.phase,
    locations_total: job.plan?.locations.length ?? null, locations_done: job.locations_done,
    pages_read: job.pages_read, products_total: (store.catalog_build || store.catalog)?.products?.length || 0,
    error: stale ? "Connection or mappings changed. Restart the catalog import." : job.error || null, per_location: job.per_location, started_at: job.started_at, finished_at: job.finished_at || null, next_sync_at: job.next_sync_at || null };
}

async function syncCatalog(ctx, store, { deadline = Infinity } = {}) {
  await beginSync(ctx, store);
  while (["queued", "running"].includes(store.catalog_sync.status) && Date.now() < deadline) {
    await advanceSync(ctx, store);
    if (store.catalog_sync.error) break;
  }
  const status = syncStatus(store);
  return { ...status, ok: status.complete, zones_checked: status.locations_done, per_zone: status.per_location,
    message: status.error || (status.complete ? "Whole-store catalog imported." : "Catalog import is incomplete; resume the sync.") };
}

function catalogFor(store, zoneId) {
  const catalog = store.catalog_build || store.catalog;
  if (!catalog) return null;
  if (store.catalog_sync?.configuration_stamp && store.catalog_sync.configuration_stamp !== configurationStamp(store)) {
    throw new HttpError(409, "catalog_stale", "Connection mappings changed. Restart the catalog import.");
  }
  const locationRequired = catalog.location_required ?? !!catalog.zone_param;
  const zid = zoneId == null || zoneId === "" ? null : String(zoneId);
  const items = catalog.products.filter(entry => zid == null || (entry.offers && entry.offers[zid]) || (!locationRequired && !entry.zones.length));
  return items.map(entry => {
    if (zid && entry.offers?.[zid]) return { ...entry.product, ...entry.offers[zid], zones: entry.zones, location_id: zid };
    // Never expose a diagnostic location's price, stock or variants as a global promise.
    return { ...(locationRequired ? neutralProduct(entry.product) : entry.product), zones: entry.zones,
      location_required: !!locationRequired, offer_status: locationRequired ? "choose_location" : "store_wide" };
  });
}

module.exports = { syncCatalog, catalogFor, prepareProductMapping, beginSync, advanceSync, syncStatus, neutralProduct };
