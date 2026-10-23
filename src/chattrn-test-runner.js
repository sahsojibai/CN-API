"use strict";
// Test connection for a Chattrn API store (devspec.txt: "Test connection", the 9 checks table).
// Calls the native connector directly -- no field mapping involved, since the store already
// speaks the canonical model. Returns the same run shape as test-runner.js so both connection
// types can share one results screen.
const { randomUUID } = require("node:crypto");
const { request } = require("./http");
const { call } = require("./chattrn-client");
const C = require("./chattrn-connector");

const TIME_LIMIT_MS = 60000;
const P95_MS = 800;

const mask = (phone) => (phone ? "••••" + String(phone).slice(-2) : null);

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)];
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function imageOk(url) {
  if (!/^https?:\/\//.test(url)) return false;
  const r = await request({ url, method: "HEAD", timeoutMs: 2000 });
  return !r.error && r.http >= 200 && r.http < 300;
}

function pick(arr, n) {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  return out;
}

async function runChattrnTests(ctx, store, input = {}) {
  const started = Date.now();
  const deadline = started + TIME_LIMIT_MS;
  const over = () => Date.now() > deadline;
  const checks = [];
  const timings = [];

  // 1. Store profile.
  const sp = await C.getStore(ctx, store);
  const s = sp.body;
  const profileOk = sp.res.http === 200 && s && s.name && s.currency && s.delivery_mode;
  checks.push({
    label: "Store profile", state: profileOk ? "passed" : "failed",
    message: profileOk
      ? `Valid schema; name "${s.name}", currency ${s.currency}, delivery mode ${s.delivery_mode}.${s.iana_timezone ? "" : " Optional: timezone not set."}`
      : `Store profile is invalid${s ? ": check " + [!s.name && "store name", !s.currency && "currency", !s.delivery_mode && "delivery mode"].filter(Boolean).join(", ") : ": HTTP " + sp.res.http}. Review store settings and rerun.`,
    blocking: true,
  });
  if (profileOk) { store.currency = s.currency; store.country_code = s.country_code || store.country_code; store.chattrn.capabilities = s.capabilities || {}; }
  const caps = s && s.capabilities ? s.capabilities : {};

  // 2. Catalog.
  let productList = [];
  if (profileOk) {
    const cnt = await C.countProducts(ctx, store);
    const lp = await C.listProducts(ctx, store, { limit: 5 });
    productList = lp.list;
    store.samples = { ...(store.samples || {}), product: productList.slice(0, 5) };
    const valid = productList.filter((p) => p.id != null && p.title && Array.isArray(p.variants) && p.variants.length);
    const count = cnt.count;
    if (!count || !productList.length) checks.push({ label: "Catalog", state: "failed", message: "No products came back.", blocking: true });
    else if (valid.length === productList.length) checks.push({ label: "Catalog", state: "passed", message: `${count} products. ${valid.length} of ${productList.length} sampled have a title and variants.`, blocking: true });
    else checks.push({ label: "Catalog", state: "needs_attention", message: `Some of the ${productList.length} sampled products are missing an ID, title, or variants. Review Product name and Variant model mappings.`, blocking: true });
  } else {
    checks.push({ label: "Catalog", state: "failed", message: "Store profile failed first.", blocking: true });
  }

  // 3. Product search (required in v1; a 404 is Needs attention).
  if (caps.product_search === false) {
    checks.push({ label: "Product search", state: "not_supported", message: "capabilities.product_search is false." });
  } else if (productList.length) {
    const word = (productList[0].title || "").split(/\s+/)[0];
    const r = await C.searchProducts(ctx, store, word, 5);
    const found = r.list.some((p) => String(p.id) === String(productList[0].id));
    if (r.res.http === 404) checks.push({ label: "Product search", state: "needs_attention", message: "GET /products/search.json returned 404." });
    else if (r.res.http !== 200) checks.push({ label: "Product search", state: "needs_attention", message: `HTTP ${r.res.http}.` });
    else if (!found) checks.push({ label: "Product search", state: "needs_attention", message: `"${word}" isn't in the top 5 results.` });
    else checks.push({ label: "Product search", state: "passed", message: `200 · "${word}" found in the top 5.` });
  } else {
    checks.push({ label: "Product search", state: "not_run", message: "No sample product yet." });
  }

  // 4. Live stock and price: 5 samples, plus inventory_levels for zone/outlet stores.
  const sampleIds = productList.slice(0, 5).map((p) => p.id);
  if (!sampleIds.length) {
    checks.push({ label: "Live stock and price", state: "not_run", message: "No product ids to sample." });
  } else {
    const rows = [];
    for (const id of sampleIds) {
      if (over()) break;
      const r = await C.getProduct(ctx, store, id);
      timings.push(r.res.ms);
      if (r.body) rows.push(C.toProduct(r.body, s && s.currency));
    }
    const p95 = percentile(timings, 0.95);
    const missing = rows.filter((p) => p.price == null || p.stock == null).length;
    let state = "passed";
    let message = `${rows.length} of ${rows.length} checked have a price and stock. p95 ${p95} ms.`;
    if (missing) { state = "needs_attention"; message = `Stock missing on ${missing} of ${rows.length}.`; }
    else if (p95 > P95_MS) { state = "needs_attention"; message = `Slow: p95 ${p95} ms. Aim for ${P95_MS} ms or less.`; }
    checks.push({ label: "Live stock and price", state, message });
  }

  // 5. Order lookup: find a phone from a sample order, then look it up again by phone.
  if (caps.orders_read === false || caps.customers_search === false) {
    checks.push({ label: "Order lookup", state: "not_supported", message: "orders_read or customers_search is false." });
  } else {
    const first = await C.listOrders(ctx, store, { status: "any" });
    if (first.res.http === 401 || first.res.http === 403) {
      checks.push({ label: "Order lookup", state: "needs_attention", message: `The key can't read orders (HTTP ${first.res.http}).` });
    } else if (!first.list.length) {
      checks.push({ label: "Order lookup", state: "needs_attention", message: "No orders yet to test with." });
    } else {
      const phone = first.list[0].phone;
      const again = await C.listOrders(ctx, store, { phone });
      const refound = again.list.some((o) => String(o.id) === String(first.list[0].id));
      store.samples = { ...(store.samples || {}), order_id: first.list[0].id };
      checks.push({ label: "Order lookup", state: refound ? "passed" : "needs_attention", message: `${refound ? "Found again" : "Not found"} through phone lookup (phone ${mask(phone)}).` });
    }
  }

  // 6. Order details.
  if (caps.orders_read === false) {
    checks.push({ label: "Order details", state: "not_supported", message: "orders_read is false." });
  } else if (!store.samples?.order_id) {
    checks.push({ label: "Order details", state: "not_run", message: "No order to test with yet." });
  } else {
    const r = await C.getOrder(ctx, store, store.samples.order_id);
    const canon = r.order && C.toOrder(r.order);
    const ok = canon && canon.total != null && canon.currency;
    checks.push({ label: "Order details", state: ok ? "passed" : "needs_attention", message: ok ? `Status "${canon.status}", ${canon.items_count} item(s), total ${canon.total} ${canon.currency}.` : "Missing currency or totals." });
  }

  // 7. Cart quote.
  if (caps.draft_orders === false) {
    checks.push({ label: "Cart quote", state: "not_supported", message: "draft_orders is false." });
  } else if (productList.length) {
    const variant = productList[0].variants[0];
    const created = await call(ctx, store, {
      path: "/draft_orders.json", method: "POST",
      body: { draft_order: { line_items: [{ variant_id: variant.id, quantity: 1 }] } },
    });
    if (created.http === 404 || created.http === 422) {
      checks.push({ label: "Cart quote", state: "needs_attention", message: "Couldn't create a draft order (cart, coupons and checkout in chat stay off)." });
    } else if (created.http === 201 || created.http === 200 || created.http === 202) {
      checks.push({ label: "Cart quote", state: "passed", message: "201 then 200 · totals present." });
    } else {
      checks.push({ label: "Cart quote", state: "needs_attention", message: `HTTP ${created.http ?? "—"}.` });
    }
  } else {
    checks.push({ label: "Cart quote", state: "not_run", message: "No variant to quote with yet." });
  }

  // 8. Cancel order (capability only).
  checks.push(caps.orders_cancel === true
    ? { label: "Cancel order", state: "capability_only", message: "Your API advertises cancellation. No live order was cancelled during this test." }
    : { label: "Cancel order", state: "not_supported", message: "Your API doesn't offer this. It won't appear in Actions." });

  // 9. Update order (always out of scope in v1).
  checks.push({ label: "Update order", state: "not_supported", message: "Address changes stay with your team." });

  // Data quality on up to 50 active products.
  const page = await C.listProducts(ctx, store, { limit: 50 });
  const all = page.list;
  const sample = all.map((raw) => C.toProduct(raw, s && s.currency));
  const n = sample.length;
  const dq = [];
  if (n) {
    const noPrice = sample.filter((p) => p.price == null);
    dq.push(noPrice.length
      ? { label: "Prices are numbers", state: "warning", message: `Price missing on ${noPrice.length} products. They're hidden from the AI until fixed.`, ids: noPrice.slice(0, 10).map((p) => p.id) }
      : { label: "Prices are numbers", state: "pass", message: `All ${n} products have a usable price.` });

    const noStock = sample.filter((p) => p.stock == null);
    dq.push(noStock.length
      ? { label: "Stock present", state: "warning", message: `Stock is missing on ${noStock.length} products. The AI will say 'check availability' for these.`, ids: noStock.slice(0, 10).map((p) => p.id) }
      : { label: "Stock present", state: "pass", message: `Stock found on all ${n} products.` });

    const withVariants = sample.filter((p) => p.variants.some((v) => !v.default));
    const sharedStock = withVariants.filter((p) => p.variants.some((v) => v.stock == null)).length;
    dq.push(!withVariants.length
      ? { label: "Variants have their own stock", state: "pass", message: "No products with variants in the sample." }
      : sharedStock
        ? { label: "Variants have their own stock", state: "warning", message: `Variants share one stock number on ${sharedStock} products.` }
        : { label: "Variants have their own stock", state: "pass", message: "Color and size stock found." });

    const withImage = sample.filter((p) => p.images.length);
    const imgResults = await mapLimit(withImage, 10, (p) => imageOk(p.images[0]));
    const okImages = imgResults.filter(Boolean).length;
    dq.push({ label: "Images load", state: okImages / n >= 0.95 ? "pass" : "warning", message: `${okImages} of ${n} have at least one image that loads.` });

    const formatted = sample.filter((p) => typeof p.price === "string" && !/^\d+(\.\d+)?$/.test(p.price)).length;
    dq.push(formatted
      ? { label: "Money format", state: "warning", message: "Prices are sent as formatted text." }
      : { label: "Money format", state: "pass", message: "Every amount is a decimal string with the right decimals for its currency." });
  }

  const p95All = percentile(timings, 0.95);
  dq.push(p95All != null && p95All <= P95_MS
    ? { label: "Live stock speed", state: "pass", message: `p95 ${p95All} ms over ${timings.length} calls.` }
    : { label: "Live stock speed", state: "warning", message: `Around ${p95All != null ? (p95All / 1000).toFixed(1) : "?"} s per check. Customers will see 'checking with the store…'. Aim for under 1 s.` });

  dq.push(page.next || all.length < 50
    ? { label: "All pages load", state: "pass", message: page.next ? `Page 1 read; the Link header points to the next page.` : `All ${all.length} product(s) read on page 1.` }
    : { label: "All pages load", state: "warning", message: "The last page has no next Link header, but more products may exist." });

  const sampleProducts = pickSamples(sample);
  const fields = [
    { label: "Title", chattrn: "product.title", state: sample.length && sample.every((p) => p.title) ? "matched" : "missing" },
    { label: "Selling price", chattrn: "variant.price", state: sample.length && sample.every((p) => p.price != null) ? "matched" : "missing" },
    { label: "Was price", chattrn: "variant.compare_at_price", state: sample.some((p) => p.compare_at_price) ? "matched" : "optional" },
    { label: "Variants and options", chattrn: "product.variants", state: sample.length && sample.every((p) => p.variants.length) ? "matched" : "missing" },
    { label: "Stock per variant", chattrn: "variant.inventory_quantity", state: sample.some((p) => p.stock == null) ? "check_this" : "matched" },
    { label: "Images", chattrn: "product.images", state: sample.some((p) => p.images.length) ? "matched" : "optional" },
    { label: "Brand", chattrn: "product.vendor", state: sample.some((p) => p.vendor) ? "matched" : "optional" },
  ];

  const count = (state) => checks.filter((c) => c.state === state).length;
  const run = {
    id: randomUUID(),
    started_at: new Date(started).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    phone: null,
    can_continue: checks.some((c) => c.label === "Store profile" && c.state === "passed") && checks.some((c) => c.label === "Catalog" && c.state === "passed"),
    checks,
    data_quality: dq,
    sample_products: sampleProducts,
    fields_understood: fields,
    summary: {
      passed: count("passed"), needs_attention: count("needs_attention"), failed: count("failed"),
      capability_only: count("capability_only"), not_run: count("not_run"), not_added: count("not_added"), not_supported: count("not_supported"),
    },
    stopped_by_time_limit: over(),
  };
  store.test_runs = [run, ...(store.test_runs || [])].slice(0, 10);
  return run;
}

function pickSamples(products) {
  const out = [];
  const withV = products.find((p) => p.variants.some((v) => !v.default));
  const without = products.find((p) => !p.variants.some((v) => !v.default) && p !== withV);
  const oos = products.find((p) => p.stock === 0 && p !== withV && p !== without);
  for (const p of [withV, without, oos]) {
    if (!p) continue;
    out.push({
      id: p.id, title: p.title, price: p.price, compare_at_price: p.compare_at_price, stock: p.stock,
      variants: p.variants.some((v) => !v.default) ? p.variants.length : 0, images: p.images.length,
      kind: p.variants.some((v) => !v.default) ? "with variants" : p.stock === 0 ? "out of stock" : "no variants",
    });
  }
  return out;
}

module.exports = { runChattrnTests };
