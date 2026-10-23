"use strict";
// Endpoint registry, endpoint checks and product paging for the store's own API (spec: Endpoint check,
// Map my existing API). A check calls the store's own endpoint and reports Responded, Needs attention,
// Error or Not checked. Write endpoints are never called.
const { call } = require("./store-client");
const { HttpError } = require("./http");
const M = require("./mapping");

const REGISTRY = [
  { key: "products", group: "Required", name: "Product list", method: "GET", path: "/products?page=:page", context: true, kind: "list" },
  { key: "detail", group: "Required", name: "Product details", method: "GET", path: "/products/:id", context: true, kind: "one" },
  { key: "search", group: "Recommended", name: "Search", method: "GET", path: "/search?q=:query", context: true, kind: "list" },
  { key: "orders", group: "Recommended", name: "Orders by phone", method: "GET", path: "/orders?phone=:phone", kind: "list" },
  { key: "order", group: "Recommended", name: "Order details", method: "GET", path: "/orders/:number", kind: "one" },
  { key: "categories", group: "Optional", name: "Categories", method: "GET", path: "/categories", kind: "list" },
  { key: "zones", group: "Optional", name: "Delivery zones", method: "GET", path: "/delivery-zone", kind: "list" },
  { key: "payments", group: "Optional", name: "Payment methods", method: "GET", path: "/payment-methods", kind: "list" },
  { key: "brand", group: "Optional", name: "Brand", method: "GET", path: "/brand", kind: "one" },
  { key: "cart", group: "Optional", name: "Cart price check", method: "POST", path: "/draft_orders", write: true },
  { key: "create_order", group: "Optional", name: "Create order", method: "POST", path: "/orders", write: true },
  { key: "cancel_order", group: "Optional", name: "Cancel order", method: "POST", path: "/orders/:number/cancel", write: true },
];

const def = (key) => REGISTRY.find((r) => r.key === key);
const PLACEHOLDER = /:(\w+)/g;

function configOf(store, key) {
  const d = def(key);
  if (!d) throw new HttpError(404, "unknown_endpoint", `Unknown endpoint "${key}".`);
  const saved = (store.endpoints || {})[key];
  return {
    key,
    name: d.name,
    group: d.group,
    write: !!d.write,
    context: !!d.context,
    method: saved?.method || d.method,
    path: saved?.path || d.path,
    added: !!saved,
    last_state: saved?.last_state ?? null,
    last_http: saved?.last_http ?? null,
    last_summary: saved?.last_summary ?? null,
    checked_at: saved?.checked_at ?? null,
  };
}

function listEndpoints(store) {
  return REGISTRY.map((r) => configOf(store, r.key));
}

function fillMissing(path, values) {
  return [...path.matchAll(PLACEHOLDER)].map((m) => m[1]).filter((n) => values[n] == null || values[n] === "");
}

function fillPath(path, values) {
  return path.replace(PLACEHOLDER, (_, n) => encodeURIComponent(String(values[n])));
}

const MISSING_HINT = {
  id: "Check Product list first, so there is a sample product.",
  query: "Check Product list first, so there is a sample word.",
  phone: "Enter a test phone for this store. It isn't stored.",
  number: "Check Orders by phone first, so there is an order number.",
};

function judgeHttp(res, host, label) {
  switch (res.error) {
    case "refused": return { state: "error", message: res.message };
    case "timeout": return { state: "error", message: "Timed out after 10 seconds." };
    case "network": return { state: "error", message: `We couldn't reach ${host} (${res.reason}). Check the address and that the API is online.` };
    case "redirect": return { state: "error", message: "The address redirects. Use the final address." };
    case "too_large": return { state: "error", message: "The response is over 2 MB." };
  }
  if (res.http === 401) return { state: "needs_attention", message: "The key was rejected for this endpoint. Check the key or the sign-in method." };
  if (res.http === 403) return { state: "needs_attention", message: `Key can't read ${label}.` };
  if (res.http === 404) return { state: "error", message: "Endpoint doesn't exist." };
  if (res.http === 429) return { state: "needs_attention", message: `The store rate-limited the check.${res.retryAfter ? ` Try again after ${res.retryAfter} s.` : ""}` };
  if (res.http >= 500) return { state: "error", message: `Server error ${res.http}.` };
  if (res.http < 200 || res.http >= 300) return { state: "error", message: `HTTP ${res.http}.` };
  if (res.empty) return { state: "error", message: "Empty response." };
  if (!res.isJson) return { state: "error", message: "Returns a web page, not JSON. Check the path." };
  return null;
}

const needs = (message, res) => ({ state: "needs_attention", message, http: res?.http ?? null, ms: res?.ms ?? null });
const responded = (summary, res) => ({ state: "responded", summary, http: res.http, ms: res.ms });

// The zone or outlet sent with every call that takes one. The saved choice wins; otherwise the zone the
// last check used (see evalProducts).
function defaultContext(store, context) {
  if (context) return context;
  const value = store.delivery?.sample_location_id;
  const name = store.delivery?.context_param;
  return value != null && value !== "" && name ? { name, value: String(value) } : null;
}

// Calls one path on the store and judges the result. Returns {res, body, link, bad}.
async function judgedPath(ctx, store, { path, context = null, label, host, useContext = true }) {
  const res = await call(ctx, store, { path, context: useContext ? defaultContext(store, context) : null });
  const bad = judgeHttp(res, host || new URL(store.base_url).host, label || "this endpoint");
  return {
    res,
    path,
    body: bad ? null : res.json,
    link: res.link,
    bad: bad ? { ...bad, http: res.http ?? null, ms: res.ms ?? null } : null,
  };
}

async function getJudged(ctx, store, key, values, context, host) {
  const d = def(key);
  return judgedPath(ctx, store, {
    path: fillPath(configOf(store, key).path, values),
    context,
    label: d.name.toLowerCase(),
    host,
    useContext: !!d.context,
  });
}

// ---- Product paging ----
// Styles: page (number in the path), offset, cursor (a next_cursor field), link (a Link header rel="next"),
// none (page 2 returns page 1 and nothing else works). Detected from the first two pages.

const CURSOR_KEYS = ["next_cursor", "nextCursor", "next_page_cursor", "next_page_token", "nextPageToken"];

function nextLinkOf(header) {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (m) return m[1];
  }
  return null;
}

function cursorOf(body) {
  if (!M.isObj(body)) return null;
  for (const k of CURSOR_KEYS) if (typeof body[k] === "string" && body[k]) return { field: k, value: body[k] };
  return null;
}

function sameFirst(a, b) {
  return a.length && b.length && String(M.idOf(a[0])) === String(M.idOf(b[0]));
}

async function detectPaging(ctx, store, context, host, p1, list1, list2) {
  if (nextLinkOf(p1.link)) return { style: "link" };
  const c = cursorOf(p1.body);
  if (c) return { style: "cursor", param: "cursor", field: c.field };
  if (Number(p1.body?.total_pages ?? p1.body?.last_page ?? p1.body?.meta?.last_page) === 1) return { style: "page", single_page: true };
  if (!list2.length || !sameFirst(list1, list2)) return { style: "page" };
  // Page number ignored: try an offset.
  const off = await judgedPath(ctx, store, { path: `/products?offset=${list1.length}`, context, label: "product list", host });
  const offList = off.bad ? [] : M.extractList(off.body) || [];
  if (offList.length && !sameFirst(list1, offList)) return { style: "offset", param: "offset" };
  return { style: "none" };
}

// Fetches page n of the product list in the detected style.
async function productPage(ctx, store, paging, n, state, context, host) {
  const base = configOf(store, "products").path;
  if (paging.style === "cursor") {
    return judgedPath(ctx, store, { path: `/products?${paging.param}=${encodeURIComponent(state.cursor)}`, context, label: "product list", host });
  }
  if (paging.style === "offset") {
    return judgedPath(ctx, store, { path: `/products?offset=${(n - 1) * state.size}`, context, label: "product list", host });
  }
  if (paging.style === "link") {
    const root = store.base_url.replace(/\/+$/, "");
    if (!state.nextUrl.startsWith(root)) {
      return { bad: { state: "error", message: "The next-page link points to another address. Stopped." } };
    }
    return judgedPath(ctx, store, { path: state.nextUrl.slice(root.length), context, label: "product list", host, useContext: true });
  }
  return judgedPath(ctx, store, { path: fillPath(base, { page: n }), context, label: "product list", host });
}

// Reads the product list page by page, up to maxPages. Saves store.paging. Returns {pages, paging, error, repeated, capped}.
async function walkProducts(ctx, store, { context = null, host, maxPages = 40, deadline = Infinity }) {
  const p1 = await getJudged(ctx, store, "products", { page: "1" }, context, host);
  if (p1.bad) return { pages: [], error: { page: 1, message: p1.bad.message } };
  const list1 = M.extractList(p1.body) || [];
  if (!list1.length) return { pages: [], paging: { style: "none" } };
  const p2 = await getJudged(ctx, store, "products", { page: "2" }, context, host);
  if (p2.bad) return { pages: [list1], error: { page: 2, message: p2.bad.message } };
  const list2 = M.extractList(p2.body) || [];
  const paging = await detectPaging(ctx, store, context, host, p1, list1, list2);
  store.paging = paging;
  if (paging.single_page) return { pages: [list1], paging };
  if (paging.style === "none") return { pages: [list1], paging, repeated: 2 };
  if (paging.style === "page" && !list2.length) return { pages: [list1], paging };

  const pages = [list1];
  const seen = new Set([String(M.idOf(list1[0]))]);
  const state = { cursor: cursorOf(p1.body)?.value ?? null, nextUrl: nextLinkOf(p1.link), size: list1.length };
  let error = null;
  let repeated = null;
  let capped = false;
  let timedOut = false;
  for (let n = 2; n <= maxPages; n++) {
    if (Date.now() > deadline) { timedOut = true; break; }
    if (paging.style === "cursor" && !state.cursor) break;
    if (paging.style === "link" && !state.nextUrl) break;
    const r = paging.style === "page" && n === 2 ? p2 : await productPage(ctx, store, paging, n, state, context, host);
    if (r.bad) { error = { page: n, message: r.bad.message }; break; }
    const list = M.extractList(r.body) || [];
    if (!list.length) break;
    if (seen.has(String(M.idOf(list[0])))) { repeated = n; break; }
    seen.add(String(M.idOf(list[0])));
    pages.push(list);
    state.cursor = cursorOf(r.body)?.value ?? null;
    state.nextUrl = nextLinkOf(r.link);
    if (n === maxPages) capped = true;
  }
  return { pages, paging, error, repeated, capped, timedOut };
}

// ---- Checks ----

function keysOf(body) {
  return M.isObj(body) ? Object.keys(body).join(", ") || "none" : "not an object";
}

function sampleProductId(store) {
  const p = store.samples?.product?.[0];
  return p ? M.idOf(p) : null;
}

function sampleWord(store) {
  const t = store.samples?.product?.[0] ? M.titleOf(store.samples.product[0]) : null;
  if (!t) return null;
  return t.split(/[^A-Za-z0-9]+/).find((w) => w.length >= 3) || null;
}

async function evalProducts(ctx, store, values, context, host) {
  const p1 = await getJudged(ctx, store, "products", { ...values, page: "1" }, context, host);
  if (p1.bad && ![400,422].includes(p1.res.http)) return p1.bad;
  let list = p1.bad ? [] : M.extractList(p1.body);
  if (!list) return needs(`No list found. Top-level keys: ${keysOf(p1.body)}.`, p1.res);

  // Discover a representative location without restricting the whole-store import.
  if (!list.length && !defaultContext(store, context)) {
    // The store's zone parameter is found by testing, not assumed. Find it now if it isn't known yet.
    if (!store.delivery?.param_confirmed) {
      const { discoverZoneParam } = require("./location");
      const discovery = await discoverZoneParam(ctx, store, { host });
      if (discovery.retryable) return { ...needs(discovery.message, p1.res), retryable: true };
      if (discovery.state !== "passed") return needs(discovery.message, p1.res);
    }
    const z = await getJudged(ctx, store, "zones", {}, null, host);
    const zones = z.bad ? [] : M.extractList(z.body) || [];
    const zoneId = store.delivery?.sample_location_id ?? (zones.length ? M.zonesOf(store, zones)[0]?.id : null);
    if (zoneId != null && store.delivery?.context_param) {
      const withZone = await judgedPath(ctx, store, {
        path: fillPath(configOf(store, "products").path, { page: 1 }),
        context: { name: store.delivery?.context_param, value: String(zoneId) },
        label: "product list",
        host,
      });
      const zl = withZone.bad ? [] : M.extractList(withZone.body) || [];
      if (zl.length) {
        store.delivery = { ...(store.delivery || {}), sample_location_id: String(zoneId) };
        store.samples = { ...(store.samples || {}), product: zl.slice(0, 5) };
        return responded(`Products discovered automatically across location-aware API. Mapping sample uses location ${zoneId}; full sync covers every location.`, withZone.res);
      }
    }
    return needs("No product samples were found automatically. Check the product/location endpoints and parameter mapping; no customer location is required during setup.", p1.res);
  }

  if (!list.length) return needs("The first page has 0 products.", p1.res);
  if (!list.every(M.isObj)) return needs("Some items are not objects.", p1.res);
  if (!list.some((r) => M.idOf(r) != null)) return needs("Products have no id-like field (id, productId, product_id…).", p1.res);
  if (!list.some((r) => M.titleOf(r) != null)) return needs("Products have no title-like field (title, name…).", p1.res);

  const p2 = await getJudged(ctx, store, "products", { ...values, page: "2" }, context, host);
  const list2 = p2.bad ? [] : M.extractList(p2.body) || [];
  store.paging = await detectPaging(ctx, store, context, host, p1, list, list2);
  if (store.paging.style === "none") {
    return needs("Page 2 repeats page 1, and no other paging style works. Pagination may be ignored.", p2.res);
  }
  store.samples = { ...(store.samples || {}), product: list.slice(0, 5) };
  if (p1.res.ms > 2000) return needs(`Responds, but slowly (${p1.res.ms} ms). Aim for under 2 s.`, p1.res);
  return responded(`200 · ${list.length} products per page`, p1.res);
}

async function evalDetail(ctx, store, values, context, host) {
  const d = await getJudged(ctx, store, "detail", values, context, host);
  if (d.bad) return d.bad;
  const obj = M.unwrapOne(d.body);
  if (!M.isObj(obj)) return needs("Responded, but the body is not an object.", d.res);
  if (values.id != null && M.idOf(obj) != null && String(M.idOf(obj)) !== String(values.id)) {
    return needs("Returned a different product than the sample.", d.res);
  }
  const hasVariants = Array.isArray(obj.variants) && obj.variants.length > 0;
  return responded(hasVariants ? "200 · variants found" : "200 · no variants", d.res);
}

async function evalSearch(ctx, store, values, context, host) {
  const s = await getJudged(ctx, store, "search", values, context, host);
  if (s.bad) return s.bad;
  const list = M.extractList(s.body);
  if (!list) return needs("Responded, but no list was found.", s.res);
  if (values.id != null && !list.some((r) => String(M.idOf(r)) === String(values.id))) {
    return needs(`The sample product isn't in the results for "${values.query}".`, s.res);
  }
  return responded("200 · results found", s.res);
}

async function evalOrders(ctx, store, values, context, host) {
  const o = await getJudged(ctx, store, "orders", values, context, host);
  if (o.bad) return o.bad;
  const list = M.extractList(o.body);
  if (!list) return needs("Responded, but no list of orders was found.", o.res);
  if (list.length) {
    const number = M.orderNumberOf(list[0]);
    store.samples = { ...(store.samples || {}), order_number: number || store.samples?.order_number, orders: list.slice(0, 20).map(M.redact) };
  }
  return responded(`200 · ${list.length} order${list.length === 1 ? "" : "s"}`, o.res);
}

async function evalOrder(ctx, store, values, context, host) {
  const o = await getJudged(ctx, store, "order", values, context, host);
  if (o.bad) return o.bad;
  const obj = M.unwrapOne(o.body);
  if (!M.isObj(obj)) return needs("Responded, but the body is not an object.", o.res);
  const hasStatus = "status" in obj || "financial_status" in obj || "fulfillment_status" in obj;
  const hasItems = Array.isArray(obj.items) || Array.isArray(obj.line_items) || Array.isArray(obj.lineItems);
  if (!hasStatus && !hasItems) return needs("No status or items found.", o.res);
  return responded("200 · status and items found", o.res);
}

async function evalGeneric(ctx, store, key, values, context, host) {
  const g = await getJudged(ctx, store, key, values, context, host);
  if (g.bad) return g.bad;
  const list = M.extractList(g.body);
  if (list) {
    if (key === "zones") store.samples = { ...(store.samples || {}), zone: list.slice(0, 5) };
    return { ...responded(`200 · ${list.length} item${list.length === 1 ? "" : "s"}`, g.res), records: list.slice(0, 50) };
  }
  if (M.isObj(g.body)) return { ...responded("200 · object returned", g.res), records: [g.body] };
  return needs("Responded, but the body is not a list or an object.", g.res);
}

function record(store, key, cfg, out) {
  store.endpoints = store.endpoints || {};
  const checked_at = new Date().toISOString();
  const prev = store.endpoints[key] || {};
  store.endpoints[key] = {
    ...prev,
    method: cfg.method,
    path: cfg.path,
    added: true,
    last_state: out.state,
    last_http: out.http ?? null,
    last_summary: out.summary || out.message || null,
    checked_at,
  };
  return { key, checked_at, ...out };
}

// input: { id?, query?, phone?, number?, context? }. Mutates store.samples, store.endpoints and store.paging; the caller saves the store.
async function checkEndpoint(ctx, store, key, input = {}) {
  const d = def(key);
  const cfg = configOf(store, key);
  if (d.write) {
    return record(store, key, cfg, {
      state: "added_not_tested",
      summary: "Added, not tested",
      message: "Create and cancel are never called during setup.",
    });
  }
  const values = {
    page: "1",
    id: input.id ?? sampleProductId(store),
    query: input.query ?? sampleWord(store),
    phone: input.phone,
    number: input.number ?? store.samples?.order_number,
  };
  const missing = fillMissing(cfg.path, values);
  if (missing.length) {
    return record(store, key, cfg, {
      state: "not_checked",
      summary: "Needs a sample value",
      message: missing.map((m) => MISSING_HINT[m] || `Enter :${m}.`).join(" "),
    });
  }
  const host = new URL(store.base_url).host;
  const context = input.context || null;
  let out;
  switch (key) {
    case "products": out = await evalProducts(ctx, store, values, context, host); break;
    case "detail": out = await evalDetail(ctx, store, values, context, host); break;
    case "search": out = await evalSearch(ctx, store, values, context, host); break;
    case "orders": out = await evalOrders(ctx, store, values, context, host); break;
    case "order": out = await evalOrder(ctx, store, values, context, host); break;
    default: out = await evalGeneric(ctx, store, key, values, context, host);
  }
  return record(store, key, cfg, out);
}

module.exports = {
  REGISTRY, configOf, listEndpoints, checkEndpoint, getJudged, judgedPath, walkProducts,
  defaultContext, sampleProductId, sampleWord, def, fillPath,
};
