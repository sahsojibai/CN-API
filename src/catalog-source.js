"use strict";
const E = require("./endpoints");
const M = require("./mapping");
const C = require("./chattrn-connector");
const { discoverZoneParam } = require("./location");
const native = store => ["chattrn_api", "laravel_package"].includes(store.connection_type);

function checked(result, label) {
  if (result.res.error || result.res.http !== 200) throw new Error(`${label}: HTTP ${result.res.http || result.res.error || "unavailable"}`);
}

async function discoverCatalog(ctx, store) {
  if (native(store)) {
    const profile = await C.getStore(ctx, store); checked(profile, "Store profile");
    if (C.validateStoreProfile(profile.body).length) throw new Error("Store profile is invalid; check the native API contract.");
    const counted = await C.countProducts(ctx, store);
    const result = await C.listLocations(ctx, store); checked(result, "Locations");
    const locations = result.list.filter(l => l.id != null && l.active !== false).map(l => ({ id: String(l.id), name: l.name || String(l.id) }));
    return { adapter: "native", scope: "global", locations, currency: profile.body.currency,
      expected_products: counted.res.http === 200 ? counted.count : null,
      location_required: locations.length !== 1,
      location_prices: profile.body?.capabilities?.location_prices === true,
      offers_unavailable: !locations.length || (locations.length > 1 && profile.body?.capabilities?.inventory_levels !== true),
      inventory: profile.body?.capabilities?.inventory_levels === true };
  }
  // Always probe the unfiltered endpoint: a previous setup/sample choice cannot narrow a sync.
  const first = await E.judgedPath(ctx, store, { path: E.fillPath(E.configOf(store, "products").path, { page: 1 }), useContext: false });
  const result = await E.getJudged(ctx, store, "zones", {}, null);
  const locations = result.bad ? [] : M.zonesOf(store, M.extractList(result.body) || []).filter(l => l.id != null).map(l => ({ id: String(l.id), name: l.name || String(l.id) }));
  if (!store.delivery?.param_confirmed && locations.length) {
    const discovery = await discoverZoneParam(ctx, store);
    if (discovery.retryable) throw Object.assign(new Error(discovery.message), {retryable:true});
  }
  const param = store.delivery?.param_confirmed ? store.delivery.context_param : null;
  if (param && locations.length) return { adapter: "mapped", scope: "locations", param, locations, location_required: true };
  if (!first.bad && (M.extractList(first.body) || []).length) {
    // Global product data can be imported even if location-dependent offers are unavailable.
    return { adapter: "mapped", scope: "global", locations, location_required: locations.length > 1,
      offers_unavailable: locations.length > 1 };
  }
  throw new Error(first.bad?.message || "No products found. Check the product and location endpoint mappings; setup never requires choosing a customer location.");
}

function productPath(store, params) {
  const base = E.fillPath(E.configOf(store, "products").path, { page: params.page || 1 });
  const url = new URL(base, store.base_url + "/");
  for (const [key, value] of Object.entries(params)) if (key !== "page") url.searchParams.set(key, String(value));
  return url.pathname + url.search;
}

async function readPage(ctx, store, plan, location, cursor = {}) {
  if (native(store)) {
    const result = await C.listProducts(ctx, store, { limit: 50, next: cursor.next }); checked(result, "Products");
    const seen = cursor.seen || [];
    const first = result.list[0]?.id;
    if (first != null && seen.includes(String(first))) throw new Error("Native product pagination repeated a page; import is incomplete.");
    return { raw: result.list, products: result.list.map(raw => C.toProduct(raw, plan.currency || store.currency)), done: !result.next,
      cursor: { next: result.next, seen: first == null ? seen : [...seen, String(first)] } };
  }
  const context = location && plan.param ? { name: plan.param, value: location.id } : null;
  let path = cursor.next || productPath(store, cursor.offset != null ? { offset: cursor.offset } : cursor.token ? { cursor: cursor.token } : { page: cursor.page || 1 });
  if (/^https?:/.test(path)) {
    const base = new URL(store.base_url), next = new URL(path);
    if (next.origin !== base.origin || !(next.pathname === base.pathname || next.pathname.startsWith(base.pathname.replace(/\/$/, "") + "/"))) throw new Error("Pagination link must remain inside the merchant API.");
    path = next.pathname.slice(base.pathname.replace(/\/$/, "").length) + next.search;
  }
  // Passing useContext explicitly avoids any saved diagnostic/default customer location.
  let result = await E.judgedPath(ctx, store, { path, context, useContext: !!context });
  if (result.bad) throw new Error(result.bad.message);
  let raw = M.extractList(result.body);
  if (!raw) throw new Error("Product endpoint returned no product array.");
  const seen = cursor.seen || [];
  if (raw.length && seen.includes(String(M.idOf(raw[0])))) {
    if ((cursor.page || 1) !== 2 || cursor.offset != null || cursor.next || cursor.token) throw new Error("Pagination repeated products; full import could not be confirmed.");
    result = await E.judgedPath(ctx, store, { path: productPath(store, { offset: cursor.size }), context, useContext: !!context });
    if (result.bad) throw new Error(result.bad.message);
    raw = M.extractList(result.body) || [];
    if (!raw.length || seen.includes(String(M.idOf(raw[0])))) throw new Error("Pagination is ignored; full import could not be confirmed.");
    cursor = { ...cursor, offset: cursor.size };
  }
  const next = C.nextLinkOf(result.link);
  const token = result.body?.next_cursor || result.body?.nextCursor || result.body?.next_page_cursor || result.body?.next_page_token || result.body?.nextPageToken;
  const total = result.body?.total ?? result.body?.pagination?.total ?? result.body?.meta?.total;
  const count = (cursor.count || 0) + raw.length;
  const lastPage = Number(result.body?.total_pages ?? result.body?.last_page ?? result.body?.meta?.last_page);
  const done = (lastPage > 0 && (cursor.page || 1) >= lastPage) || !raw.length || (Number.isFinite(total) && count >= total) || (cursor.next && !next) || (cursor.token && !token);
  return { raw, products: raw.map(row => M.toProduct(store, row)), done,
    cursor: { page: (cursor.page || 1) + 1, size: cursor.size || raw.length, count,
      seen: raw.length ? [...seen, String(M.idOf(raw[0]))] : seen,
      ...(next ? { next } : token ? { token } : cursor.offset != null ? { offset: cursor.offset + raw.length } : {}) } };
}

async function nativeOffers(ctx, store, products, location, {deadline = Date.now() + 60000} = {}) {
  const ids = [...new Set(products.flatMap(p => p.variants.map(v => v.inventory_item_id)).filter(Boolean))];
  const levels = [];
  for (let start = 0; start < ids.length; start += 50) {
    if (Date.now() > deadline) throw new Error("Location inventory checks reached their time limit. Retry to resume.");
    const result = await C.inventoryLevels(ctx, store, { itemIds: ids.slice(start, start + 50), locationIds: [location.id] });
    checked(result, "Location inventory"); levels.push(...result.list);
  }
  return products.map(product => {
    const variants = product.variants.map(variant => {
      const level = levels.find(l => String(l.location_id) === location.id && String(l.inventory_item_id) === String(variant.inventory_item_id));
      return { ...variant, stock: level ? M.toNumber(level.available) : null,
        price: level && Object.hasOwn(level, "price") ? M.toMoney(level.price)
          : !level && (store.chattrn?.capabilities?.location_prices || store.catalog_sync?.plan?.location_prices) ? null : variant.price,
        compare_at_price: level && Object.hasOwn(level, "compare_at_price") ? M.toMoney(level.compare_at_price) : variant.compare_at_price };
    });
    return { ...product, variants, stock: variants.every(v => v.stock != null) ? variants.reduce((sum, v) => sum + v.stock, 0) : null,
      price: variants[0]?.price ?? null, compare_at_price: variants[0]?.compare_at_price ?? null };
  });
}

module.exports = { discoverCatalog, readPage, nativeOffers, native };
