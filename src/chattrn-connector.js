"use strict";
// Native connector for the Chattrn API (devspec.txt: "The Chattrn API contract"). Unlike the mapped
// connector, a Chattrn API store already speaks the canonical model, so conversion is mostly a
// flatten/normalise pass rather than a field-by-field mapping.
const { call } = require("./chattrn-client");
const M = require("./mapping"); // reuse toMoney/toNumber/isObj helpers so both connectors agree on shape

const SUPPORTED_VERSIONS = ["2026-10"];
const CURRENCY_RE = /^[A-Z]{3}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

function nextLinkOf(header) {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (m) return m[1];
  }
  return null;
}

// ---- canonical conversion (already Shopify-shaped; this just normalises types) ----

function toVariant(v) {
  if (!M.isObj(v)) return null;
  return {
    id: v.id != null ? String(v.id) : null,
    title: v.title || null,
    price: M.toMoney(v.price),
    compare_at_price: v.compare_at_price != null ? M.toMoney(v.compare_at_price) : null,
    stock: M.toNumber(v.inventory_quantity),
    sku: v.sku || null,
    inventory_item_id: v.inventory_item_id != null ? String(v.inventory_item_id) : null,
  };
}

function toProduct(raw, storeCurrency) {
  if (!M.isObj(raw)) return null;
  const images = Array.isArray(raw.images) ? raw.images.map((i) => (M.isObj(i) ? i.src : i)).filter(Boolean) : [];
  const variants = Array.isArray(raw.variants) && raw.variants.length
    ? raw.variants.map(toVariant).filter(Boolean)
    : [{ id: raw.id != null ? String(raw.id) : null, title: "Default", price: M.toMoney(raw.price), compare_at_price: null, stock: null, sku: null, default: true }];
  const stock = variants.reduce((s, v) => (v.stock == null ? s : (s || 0) + v.stock), variants.some((v) => v.stock != null) ? 0 : null);
  return {
    id: raw.id != null ? String(raw.id) : null,
    title: raw.title || null,
    description: raw.body_html || raw.description || null,
    price: variants[0] ? variants[0].price : null,
    compare_at_price: variants[0] ? variants[0].compare_at_price : null,
    currency: storeCurrency || null,
    stock,
    images,
    updated_at: raw.updated_at || null,
    vendor: raw.vendor || null,
    status: raw.status || null,
    handle: raw.handle || null,
    variants,
  };
}

const CANON_STATUS = ["Pending payment", "Confirmed, not shipped", "Shipped", "Delivered", "Cancelled"];

function statusOf(o) {
  if (o.cancelled_at) return "Cancelled";
  if ((o.fulfillments || []).some((f) => f.shipment_status === "delivered")) return "Delivered";
  if (o.fulfillment_status === "partial" || o.fulfillment_status === "fulfilled" ||
      (o.fulfillments || []).some((f) => ["in_transit", "out_for_delivery", "attempted_delivery"].includes(f.shipment_status))) return "Shipped";
  const cod = (o.payment_gateway_names || []).includes("cod");
  if (o.financial_status === "pending" && !cod) return "Pending payment";
  return "Confirmed, not shipped";
}

function toOrder(raw) {
  if (!M.isObj(raw)) return null;
  return {
    id: raw.id != null ? String(raw.id) : null,
    number: raw.name || (raw.order_number != null ? `#${raw.order_number}` : null),
    status: statusOf(raw),
    raw_status: raw.financial_status || null,
    total: M.toMoney(raw.total_price),
    currency: raw.currency || null,
    created_at: raw.created_at || null,
    items_count: Array.isArray(raw.line_items) ? raw.line_items.length : null,
    fulfillments: raw.fulfillments || [],
  };
}

// ---- calls ----

async function getStore(ctx, store) {
  const res = await call(ctx, store, { path: "/store.json" });
  return { res, body: res.json && res.json.store };
}

function withLimit(path, params) {
  const q = new URLSearchParams(params);
  return q.toString() ? `${path}?${q}` : path;
}

async function listProducts(ctx, store, { limit = 50, page_info, since_id, updated_at_min, fields, next } = {}) {
  const params = {};
  if (limit) params.limit = String(limit);
  if (page_info) params.page_info = page_info;
  if (since_id) params.since_id = String(since_id);
  if (updated_at_min) params.updated_at_min = updated_at_min;
  if (fields) params.fields = fields;
  const res = await call(ctx, store, { path: next || withLimit("/products.json", params) });
  const list = res.json && Array.isArray(res.json.products) ? res.json.products : [];
  return { res, list, next: nextLinkOf(res.link) };
}

async function countProducts(ctx, store) {
  const res = await call(ctx, store, { path: "/products/count.json" });
  return { res, count: res.json && typeof res.json.count === "number" ? res.json.count : null };
}

async function getProduct(ctx, store, id) {
  const res = await call(ctx, store, { path: `/products/${encodeURIComponent(id)}.json` });
  return { res, body: res.json && res.json.product };
}

async function searchProducts(ctx, store, q, limit = 10) {
  const res = await call(ctx, store, { path: withLimit("/products/search.json", { q, limit: String(limit) }) });
  const list = res.json && Array.isArray(res.json.products) ? res.json.products : [];
  return { res, list };
}

async function listLocations(ctx, store) {
  const res = await call(ctx, store, { path: "/locations.json" });
  const list = res.json && Array.isArray(res.json.locations) ? res.json.locations : [];
  return { res, list };
}

async function inventoryLevels(ctx, store, { itemIds = [], locationIds = [] } = {}) {
  const params = {};
  if (itemIds.length) params.inventory_item_ids = itemIds.slice(0, 50).join(",");
  if (locationIds.length) params.location_ids = locationIds.slice(0, 50).join(",");
  const res = await call(ctx, store, { path: withLimit("/inventory_levels.json", params) });
  const list = res.json && Array.isArray(res.json.inventory_levels) ? res.json.inventory_levels : [];
  return { res, list };
}

async function resolveArea(ctx, store, area) {
  const res = await call(ctx, store, { path: withLimit("/locations/resolve.json", { area }) });
  return { res, resolution: res.json && res.json.resolution };
}

async function searchCustomers(ctx, store, query) {
  const res = await call(ctx, store, { path: withLimit("/customers/search.json", { query }) });
  const list = res.json && Array.isArray(res.json.customers) ? res.json.customers : [];
  return { res, list };
}

async function listOrders(ctx, store, { phone, name, status = "any" } = {}) {
  const params = { status };
  if (name) params.name = name;
  let res;
  if (phone) {
    const c = await searchCustomers(ctx, store, `phone:${phone}`);
    if (!c.list.length) return { res: c.res, list: [] };
    const o = await call(ctx, store, { path: `/customers/${encodeURIComponent(c.list[0].id)}/orders.json?status=any` });
    const list = o.json && Array.isArray(o.json.orders) ? o.json.orders : [];
    return { res: o, list, customer: c.list[0] };
  }
  res = await call(ctx, store, { path: withLimit("/orders.json", params) });
  const list = res.json && Array.isArray(res.json.orders) ? res.json.orders : [];
  return { res, list };
}

async function getOrder(ctx, store, id) {
  const res = await call(ctx, store, { path: `/orders/${encodeURIComponent(id)}.json` });
  const order = res.json && res.json.order;
  if (!order) return { res, order: null };
  const f = await call(ctx, store, { path: `/orders/${encodeURIComponent(id)}/fulfillments.json` });
  if (f.json && Array.isArray(f.json.fulfillments)) order.fulfillments = f.json.fulfillments;
  return { res, order };
}

// ---- API connection check (devspec.txt: "API connection check") ----

function httpProblem(res) {
  if (res.error === "timeout") return { state: "error", message: "We couldn't reach the store (timed out after 10 seconds). Check the address and that the API is online." };
  if (res.error === "network") return { state: "error", message: `We couldn't reach the host (${res.reason}). Check the address and that the API is online.` };
  if (res.error === "refused") return { state: "error", message: res.message };
  if (res.http === 401) return { state: "error", message: "The API key was rejected. Copy it again from your store admin." };
  if (res.http === 403) return { state: "error", message: "This key can't read the store profile. Give it read access." };
  if (res.http === 404) return { state: "error", message: "No Chattrn API at this address. Check the base URL ends with the Chattrn path." };
  if (res.http != null && (res.http < 200 || res.http >= 300)) return { state: "error", message: `HTTP ${res.http}.` };
  if (res.isJson === false) return { state: "error", message: "This address returned a web page, not the API. Check the base URL." };
  return null;
}

function validateStoreProfile(s) {
  const problems = [];
  if (!s?.name || typeof s.name !== "string") problems.push({ path: "store.name", problem: "must be a nonempty string" });
  if (!s || typeof s !== "object") problems.push({ path: "store", problem: "must be a JSON object" });
  else {
    if (!s.api_version || !SUPPORTED_VERSIONS.includes(s.api_version)) problems.push({ path: "store.api_version", problem: `must be one of ${SUPPORTED_VERSIONS.join(", ")}` });
    if (!s.currency || !CURRENCY_RE.test(s.currency)) problems.push({ path: "store.currency", problem: "must be an ISO 4217 code" });
    if (!s.country_code || !COUNTRY_RE.test(s.country_code)) problems.push({ path: "store.country_code", problem: "must be an ISO 3166-1 alpha-2 country code" });
    if (!s.capabilities || s.capabilities.products !== true) problems.push({ path: "store.capabilities.products", problem: "must be true" });
    if (!["zone", "outlet"].includes(s.delivery_mode)) problems.push({ path: "store.delivery_mode", problem: "must be zone or outlet" });
  }
  return problems;
}

async function checkStore(ctx, store, { websiteUrl, tokenOverride } = {}) {
  const started = Date.now();
  const first = await call(ctx, store, { path: "/store.json", tokenOverride });
  let p = httpProblem(first);
  if (p) return { state: "error", http_status: first.http, message: p.message, duration_ms: Date.now() - started };

  const s = first.json && first.json.store;
  const problems = validateStoreProfile(s);
  if (problems.length) {
    return { state: "error", http_status: first.http, message: `Lists up to 5 problems: ${problems.slice(0, 5).map((x) => `${x.path}: ${x.problem}`).join("; ")}`, problems: problems.slice(0, 5), duration_ms: Date.now() - started };
  }

  let domainWarning = null;
  if (websiteUrl && s.domain) {
    const want = String(websiteUrl).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
    const got = String(s.domain).replace(/^www\./, "");
    if (want && got && want !== got) domainWarning = `store.json's domain (${s.domain}) doesn't match the Website URL you entered.`;
  }

  const prod = await call(ctx, store, { path: "/products.json?limit=1", tokenOverride });
  p = httpProblem(prod);
  if (p) {
    const extra = prod.http === 401 || prod.http === 403 ? "This key reads the store but not products." : p.message;
    return { state: "error", http_status: prod.http, message: extra, duration_ms: Date.now() - started };
  }

  return {
    state: "connected",
    http_status: first.http,
    message: domainWarning || "Connected. Store profile and products responded.",
    store: s,
    duration_ms: Date.now() - started,
  };
}

module.exports = {
  validateStoreProfile, SUPPORTED_VERSIONS, toProduct, toVariant, toOrder, statusOf, CANON_STATUS,
  getStore, listProducts, countProducts, getProduct, searchProducts, listLocations,
  inventoryLevels, resolveArea, searchCustomers, listOrders, getOrder, checkStore, nextLinkOf,
};
