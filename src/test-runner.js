"use strict";
// Test connection for a mapped store (spec: Test connection). Read-only: no write endpoint is ever called.
// Runs within 60 s. Results are returned in the same order as the screen. Phone numbers are masked and never saved.
const { randomUUID } = require("node:crypto");
const { request } = require("./http");
const { getJudged, checkEndpoint, configOf, walkProducts } = require("./endpoints");
const M = require("./mapping");
const { discoverZoneParam } = require("./location");

const TIME_LIMIT_MS = 60000;
const P95_MS = 800;
const DQ_SAMPLE = 50;
const MAX_PAGES = 40;

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

function zoneContext(store, zone) {
  if (zone == null || zone === "") return null;
  const name = store.delivery?.context_param;
  return name ? { name, value: String(zone) } : null;
}

function pick(arr, n) {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  return out;
}

const fromCheck = (label, r, blocking = false) => ({
  label,
  state: r.state === "responded" ? "passed" : r.state === "error" ? "failed" : r.state === "needs_attention" ? "needs_attention" : r.state,
  message: r.summary || r.message || "",
  blocking,
});

async function runTests(ctx, store, input = {}) {
  const started = Date.now();
  const deadline = started + TIME_LIMIT_MS;
  const over = () => Date.now() > deadline;
  const host = new URL(store.base_url).host;
  // Location parameter: which query name this store reads its zone from. Found once, then kept
  // unless the test is asked to look again.
  const location = store.delivery?.param_confirmed && !input.rediscover
    ? { state: "passed", message: `Using ${store.delivery.context_param}, confirmed earlier.` }
    : await discoverZoneParam(ctx, store, { host });
  const context = zoneContext(store, input.zone);
  const checks = [];
  const timings = [];

  // 1. Store profile: name and currency, from Store details.
  const firstRaw = store.samples?.product?.[0];
  const currency = store.currency || (firstRaw ? M.toProduct(store, firstRaw).currency : null);
  const profileOk = !!store.name && !!currency;
  checks.push({
    label: "Store profile",
    state: profileOk ? "passed" : "needs_attention",
    message: profileOk ? "Name and currency set in Store details." : "Add the store currency in Store details.",
    blocking: true,
  });
  checks.push({ label: "Location parameter", state: location.state, message: location.message, blocking: false });

  // 2. Catalog: products on page 1, first five must have an id, title and price.
  const p1 = await getJudged(ctx, store, "products", { page: "1" }, context, host);
  let productList = [];
  if (p1.bad) {
    checks.push({ label: "Catalog", state: "failed", message: p1.bad.message, blocking: true });
  } else {
    productList = M.extractList(p1.body) || [];
    store.samples = { ...(store.samples || {}), product: productList.slice(0, 5) };
    const five = productList.slice(0, 5).filter(M.isObj).map((raw) => ({ raw, p: M.toProduct(store, raw) }));
    const valid = five.filter(({ p }) => p.id && p.title && p.price != null);
    if (!five.length) checks.push({ label: "Catalog", state: "failed", message: "No products on page 1.", blocking: true });
    else if (valid.length === five.length) checks.push({ label: "Catalog", state: "passed", message: `${valid.length} of ${five.length} sample products have an id, title and price.`, blocking: true });
    else checks.push({ label: "Catalog", state: "needs_attention", message: `${five.length - valid.length} sample product(s) are missing an id, title or price.`, blocking: true });
  }

  // 3. Product search.
  if (!configOf(store, "search").added) {
    checks.push({ label: "Product search", state: "not_added", message: "Not added. Product search falls back to the full list, which is slower." });
  } else if (!over()) {
    const r = await checkEndpoint(ctx, store, "search", { context });
    checks.push({ ...fromCheck("Product search", r), state: r.state === "responded" ? "passed" : "needs_attention" });
  }

  // 4. Live stock and price: 20 detail calls. The first five must have a price and stock.
  const ids = productList.slice(0, 20).map((r) => M.idOf(r)).filter((x) => x != null);
  if (!ids.length) {
    checks.push({ label: "Live stock and price", state: "not_run", message: "No product ids to sample." });
  } else {
    const rows = [];
    const problems = [];
    for (const id of ids) {
      if (over()) break;
      const r = await getJudged(ctx, store, "detail", { id }, context, host);
      timings.push(r.res.ms);
      if (r.bad) { problems.push(`${id}: ${r.bad.message}`); continue; }
      const obj = M.unwrapOne(r.body);
      rows.push({ id, p: M.toProduct(store, obj) });
    }
    const p95 = percentile(timings, 0.95);
    const first5 = rows.slice(0, 5);
    const missing = first5.filter((x) => x.p.stock == null || x.p.price == null).map(x => ({
      id: String(x.id), title: x.p.title, missing: [x.p.price == null ? "price" : null, x.p.stock == null ? "stock" : null].filter(Boolean),
    }));
    const noStock = missing.length;
    let state = "passed";
    let message = `${first5.length} of ${first5.length} checked have a price and stock. p95 ${p95} ms.`;
    if (problems.length) { state = "failed"; message = problems[0]; }
    else if (rows.length !== ids.length) { state = "failed"; message = "Stock checks did not finish. Run verification again."; }
    else if (noStock) { state = "needs_attention"; message = `${noStock} of ${first5.length} checked have missing values: ${missing.map(x => `${x.title || x.id} (${x.id}): ${x.missing.join(" and ")}`).join("; ")}. Review the product-detail response and field mapping.`; }
    else if (p95 > P95_MS) { state = "needs_attention"; message = `Slow: p95 ${p95} ms. Aim for ${P95_MS} ms or less.`; }
    checks.push({ label: "Live stock and price", state, message, blocking: true, affected_products: missing });
  }

  // 5. Order lookup, by a test phone entered for this run only (never stored).
  if (!input.phone) {
    checks.push({ label: "Order lookup", state: "not_run", message: "Add a test phone to check orders. It isn't stored." });
  } else if (!configOf(store, "orders").added) {
    checks.push({ label: "Order lookup", state: "not_added", message: "Not added. Orders can't be checked." });
  } else {
    const r = await checkEndpoint(ctx, store, "orders", { phone: input.phone, context });
    checks.push({ label: "Order lookup", state: r.state === "responded" ? "passed" : r.state === "not_checked" ? "not_run" : "needs_attention", message: `${r.summary || r.message} (phone ${mask(input.phone)})` });
  }

  // 6. Order details, for the order number found above.
  if (!configOf(store, "order").added) {
    checks.push({ label: "Order details", state: "not_added", message: "Not added." });
  } else if (!store.samples?.order_number) {
    checks.push({ label: "Order details", state: "not_run", message: "No order to test with yet." });
  } else {
    const r = await checkEndpoint(ctx, store, "order", { number: store.samples.order_number });
    checks.push({ label: "Order details", state: r.state === "responded" ? "passed" : "needs_attention", message: r.summary || r.message });
  }

  // 7 to 9. Writes are never run on a store. Only the capability is shown.
  checks.push({ label: "Cart quote", state: "not_added", message: "Not added. Cart and checkout in chat stay off until a cart endpoint is added and checked." });
  checks.push({ label: "Cancel order", state: "not_added", message: "Added, not tested. Never called during tests." });
  checks.push({ label: "Update order", state: "not_supported", message: "Address changes stay with your team." });

  // Data quality on up to 50 products: the first page plus random pages.
  const walk = await walkProducts(ctx, store, { context, host, maxPages: MAX_PAGES, deadline });
  const pages = walk.pages;
  const repeated = walk.repeated || null;
  const pageError = walk.error || null;
  const stoppedAtCap = !!walk.capped || !!walk.timedOut;
  const dq = [];
  const all = pages.flat();
  const first = pages[0] || [];
  const rest = all.slice(first.length);
  const sampleRaw = [...first.slice(0, 20), ...pick(rest, Math.max(0, DQ_SAMPLE - Math.min(20, first.length)))].slice(0, DQ_SAMPLE);
  const sample = sampleRaw.map((raw) => ({ raw, p: M.toProduct(store, raw) }));
  const n = sample.length;

  if (n) {
    const noPrice = sample.filter((x) => x.p.price == null);
    dq.push(noPrice.length
      ? { label: "Prices are numbers", state: "warning", message: `Price missing on ${noPrice.length} products. They're hidden from the AI until fixed.`, ids: noPrice.slice(0, 10).map((x) => x.p.id) }
      : { label: "Prices are numbers", state: "pass", message: `All ${n} products have a usable price.` });

    const noStock = sample.filter((x) => x.p.stock == null);
    dq.push(noStock.length
      ? { label: "Stock present", state: "warning", message: `Stock is missing on ${noStock.length} products. The AI will say 'check availability' for these.`, ids: noStock.slice(0, 10).map((x) => x.p.id) }
      : { label: "Stock present", state: "pass", message: `Stock found on all ${n} products.` });

    const withVariants = sample.filter((x) => x.p.variants.some((v) => !v.default));
    const sharedStock = withVariants.filter((x) => x.p.variants.some((v) => v.stock == null)).length;
    if (!withVariants.length) dq.push({ label: "Variants have their own stock", state: "pass", message: "No products with variants in the sample." });
    else if (sharedStock) dq.push({ label: "Variants have their own stock", state: "warning", message: `Variants share one stock number on ${sharedStock} products.` });
    else dq.push({ label: "Variants have their own stock", state: "pass", message: "Color and size stock found." });

    const withImage = sample.filter((x) => x.p.images.length);
    const imgResults = await mapLimit(withImage, 10, (x) => imageOk(x.p.images[0]));
    const okImages = imgResults.filter(Boolean).length;
    const share = okImages / n;
    dq.push({
      label: "Images load",
      state: share >= 0.95 ? "pass" : "warning",
      message: `${okImages} of ${n} have at least one image that loads.`,
    });

    const formatted = sample.filter((x) => {
      const raw = M.getPath(x.raw, M.sourcePathOf(store, "product", "price"));
      return typeof raw === "string" && !/^\d+(\.\d+)?$/.test(raw.trim());
    }).length;
    dq.push(formatted
      ? { label: "Money format", state: "warning", message: "Prices are sent as formatted text." }
      : { label: "Money format", state: "pass", message: "Every amount is a number or a decimal string." });
  }

  // Drift: a mapped field that has been absent for 3 runs in a row. The fallback is used when one is set.
  if (sampleRaw.length) {
    store.drift = store.drift || {};
    for (const row of M.currentRows(store, "product")) {
      if (!row.source_path || row.key === "variants") continue;
      const present = sampleRaw.some((x) => M.getPath(x, row.source_path) !== undefined);
      store.drift[row.key] = present ? 0 : (store.drift[row.key] || 0) + 1;
      if (!present && store.drift[row.key] >= 3) {
        dq.push({
          label: "Field drift",
          state: "warning",
          message: `${row.label} stopped appearing in the last ${store.drift[row.key]} runs.` +
            (row.fallback_path ? ` Chattrn is using ${row.fallback_path} for now.` : " No fallback is set, so it shows as missing."),
        });
      }
    }
  }

  const pageMsg = repeated
    ? `Page ${repeated} repeated items.`
    : pageError
      ? `Page ${pageError.page} failed: ${pageError.message}`
    : stoppedAtCap
      ? `Stopped at page ${MAX_PAGES} (test limit). Later pages were not read.`
      : `Page 1 to ${pages.length} read without gaps or repeats.`;
  if (store.delivery?.sample_location_id) dq.push({label:"Whole-store coverage",state:"warning",message:"These are automatic diagnostic samples. Complete coverage of every location is tracked by the background catalog import."});
  dq.push({ label: "All pages load", state: repeated || pageError || stoppedAtCap ? "warning" : pages.length ? "pass" : "failed", message: pageMsg + (store.delivery?.sample_location_id ? " Diagnostic sample location only; not a complete store import." : "") });

  const p95 = percentile(timings, 0.95);
  dq.push(p95 != null && p95 <= P95_MS
    ? { label: "Live stock speed", state: "pass", message: `p95 ${p95} ms over ${timings.length} calls.` }
    : { label: "Live stock speed", state: "warning", message: `Around ${p95 != null ? (p95 / 1000).toFixed(1) : "?"} s per check. Customers will see 'checking with the store…'. Aim for under 1 s.` });

  const sampleProducts = pickSamples(sample.map((x) => x.p));
  const fields = M.currentRows(store, "product").map((r) => ({
    label: r.label,
    chattrn: r.chattrn,
    state: r.source_path ? "matched" : r.level === "required" ? "missing" : "optional",
    source_path: r.source_path,
  }));

  const count = (state) => checks.filter((c) => c.state === state).length;
  const run = {
    id: randomUUID(),
    started_at: new Date(started).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    phone: mask(input.phone),
    can_continue: ["Store profile", "Catalog", "Live stock and price"].every(label => checks.some(c => c.label === label && c.state === "passed")) && dq.some(c => c.label === "All pages load" && c.state === "pass"),
    activation_blockers: [
      ...["Store profile", "Catalog", "Live stock and price"].filter(label => !checks.some(c => c.label === label && c.state === "passed")).map(label => {
        const check = checks.find(c => c.label === label);
        return {label, message: check?.message || "Required check did not run."};
      }),
      ...(!dq.some(c => c.label === "All pages load" && c.state === "pass") ? [{label:"All pages load",message:dq.find(c => c.label === "All pages load")?.message || "Pagination check did not finish."}] : []),
    ],
    checks,
    data_quality: dq,
    sample_products: sampleProducts,
    fields_understood: fields,
    summary: {
      passed: count("passed"),
      needs_attention: count("needs_attention"),
      failed: count("failed"),
      not_run: count("not_run"),
      not_added: count("not_added"),
      not_supported: count("not_supported"),
    },
    stopped_by_time_limit: over(),
  };
  store.test_runs = [run, ...(store.test_runs || [])].slice(0, 10);
  return run;
}

// Three rows: one with variants, one without, one out of stock if any.
function pickSamples(products) {
  const out = [];
  const withV = products.find((p) => p.variants.some((v) => !v.default));
  const without = products.find((p) => !p.variants.some((v) => !v.default) && p !== withV);
  const oos = products.find((p) => p.stock === 0 && p !== withV && p !== without);
  for (const p of [withV, without, oos]) {
    if (!p) continue;
    out.push({
      id: p.id,
      title: p.title,
      price: p.price,
      compare_at_price: p.compare_at_price,
      stock: p.stock,
      variants: p.variants.some((v) => !v.default) ? p.variants.length : 0,
      images: p.images.length,
      kind: p.variants.some((v) => !v.default) ? "with variants" : p.stock === 0 ? "out of stock" : "no variants",
    });
  }
  return out;
}

module.exports = { runTests, percentile, mask };
