"use strict";
// End-to-end tests against the local mock store. ALLOW_PRIVATE_HOSTS is set for these tests only.
process.env.ALLOW_PRIVATE_HOSTS = "1";
process.env.CHATTRN_SECRET = "test-secret-for-the-suite-only";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../src/server");
const { createMockServer, KEY, PREFIX } = require("../src/mock-store");

let base, mockBase, dataDir, servers = [], mock;
const KEY_OK = KEY;
const KEY_BAD = "wrong-key-1234567890";

async function api(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

let storeId;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chattrn-test-"));
  mock = createMockServer();
  servers.push(mock.server);
  const mockPort = await listen(mock.server);
  mockBase = `http://127.0.0.1:${mockPort}${PREFIX}`;
  const app = createApp({ dataDir, publicDir: path.join(__dirname, "..", "public") });
  servers.push(app.server);
  const port = await listen(app.server);
  base = `http://127.0.0.1:${port}`;
});

test.after(() => {
  for (const s of servers) s.close();
});

test("the flow tester page is served", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<html/i);
});

test("creating a store rejects a bad base URL and a missing key", async () => {
  let r = await api("POST", "/api/stores", { delivery_mode: "zone", name: "Test", base_url: mockBase + "/store.json?x=1", auth: { mode: "key", key: KEY_OK } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "base_url_query");
  r = await api("POST", "/api/stores", { delivery_mode: "zone", name: "Test", base_url: mockBase, auth: { mode: "key" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "key_required");
});

test("create store: key is encrypted at rest and never returned", async () => {
  const r = await api("POST", "/api/stores", {
    delivery_mode: "zone",
    name: "Mock Store", website_url: "https://mock.example", base_url: mockBase + "/",
    currency: "bdt", auth: { mode: "key", header: "X-API-Key", key: KEY_OK },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.auth.key_saved, true);
  assert.equal(r.body.currency, "BDT");
  assert.equal(JSON.stringify(r.body).includes(KEY_OK), false);
  storeId = r.body.id;
  const onDisk = fs.readFileSync(path.join(dataDir, "stores.json"), "utf8");
  assert.equal(onDisk.includes(KEY_OK), false, "plain key must not be on disk");
});

test("replacing the key with a bad one is refused and the old key still works", async () => {
  const r = await api("PUT", `/api/stores/${storeId}/auth`, { mode: "key", key: KEY_BAD });
  assert.equal(r.status, 422);
  assert.match(r.body.error.message, /old key still works/);
  const c = await api("POST", `/api/stores/${storeId}/endpoints/products/check`, {});
  assert.equal(c.body.state, "responded");
});

test("product list check: responded, with pagination verified", async () => {
  const r = await api("POST", `/api/stores/${storeId}/endpoints/products/check`, {});
  assert.equal(r.body.state, "responded");
  assert.equal(r.body.summary, "200 · 20 products per page");
});

test("orders: without a phone it is not checked; with the test phone it responds", async () => {
  await api("PUT", `/api/stores/${storeId}/endpoints/orders`, { path: "/orders?phone=:phone" });
  let r = await api("POST", `/api/stores/${storeId}/endpoints/orders/check`, {});
  assert.equal(r.body.state, "not_checked");
  r = await api("POST", `/api/stores/${storeId}/endpoints/orders/check`, { phone: "01700000000" });
  assert.equal(r.body.state, "responded");
  assert.equal(r.body.summary, "200 · 2 orders");
});

test("orders with a wrong key show Needs attention, not Error", async () => {
  await api("PUT", `/api/stores/${storeId}/auth`, { mode: "key", key: KEY_OK });
  // Change the stored key path by checking with an unauthenticated call: no key means 401 from the mock.
  const s = await api("POST", "/api/stores", { delivery_mode: "zone", name: "No key", base_url: mockBase, auth: { mode: "none" } });
  await api("PUT", `/api/stores/${s.body.id}/endpoints/orders`, { path: "/orders?phone=:phone" });
  const r = await api("POST", `/api/stores/${s.body.id}/endpoints/orders/check`, { phone: "01700000000" });
  assert.equal(r.body.state, "needs_attention");
  assert.match(r.body.message, /rejected/);
});

test("endpoints that write are never called", async () => {
  mock.requests.length = 0;
  const r = await api("POST", `/api/stores/${storeId}/endpoints/cancel_order/check`, {});
  assert.equal(r.body.state, "added_not_tested");
  assert.equal(mock.requests.some((x) => ["POST", "PUT", "PATCH", "DELETE"].includes(x.method)), false);
});

test("propose matching: prioobazar-style names map to Chattrn fields", async () => {
  const r = await api("POST", `/api/stores/${storeId}/mapping/propose`, { resource: "product" });
  assert.equal(r.status, 200);
  const row = (k) => r.body.rows.find((x) => x.key === k);
  assert.equal(row("id").source_path, "productId");
  assert.equal(row("title").source_path, "productName");
  assert.equal(row("price").source_path, "sellPrice");
  assert.equal(row("compare_at_price").source_path, "comparePrice");
  assert.equal(row("stock").source_path, "totalStock", "inStock is a boolean and must not be used as a number");
  assert.equal(row("images").source_path, "images");
  assert.equal(row("variants").source_path, "variants");
  assert.equal(row("updated_at").source_path, null);
  assert.equal(row("updated_at").state, "missing");
  assert.equal(r.body.rows.some((x) => x.state === "check_this"), false);
});

test("save is refused until the required fields are matched", async () => {
  const p = await api("POST", `/api/stores/${storeId}/mapping/propose`, { resource: "product" });
  const rows = p.body.rows.map((x) => ({ key: x.key, source_path: x.source_path, state: x.state }));
  const r = await api("PUT", `/api/stores/${storeId}/mapping`, { resource: "product", rows: rows.filter((x) => x.key !== "stock") });
  assert.equal(r.status, 422);
  assert.match(r.body.error.message, /Total stock/);
});

test("save product mapping: updated_at may be marked not in the store", async () => {
  const p = await api("POST", `/api/stores/${storeId}/mapping/propose`, { resource: "product" });
  const rows = p.body.rows.map((x) => ({
    key: x.key, source_path: x.source_path, state: x.state,
    not_in_store: x.key === "updated_at" ? true : undefined,
  }));
  const r = await api("PUT", `/api/stores/${storeId}/mapping`, { resource: "product", rows });
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 1);
});

test("save variant mapping from the first product's variants", async () => {
  const p = await api("POST", `/api/stores/${storeId}/mapping/propose`, { resource: "variant" });
  assert.equal(p.status, 200);
  const row = (k) => p.body.rows.find((x) => x.key === k);
  assert.equal(row("id").source_path, "variantId");
  assert.equal(row("title").source_path, "optionValue");
  assert.equal(row("stock").source_path, "stockQty");
  const r = await api("PUT", `/api/stores/${storeId}/mapping`, { resource: "variant", rows: p.body.rows });
  assert.equal(r.status, 200);
});

test("unscoped preview keeps canonical identities without claiming a location price", async () => {
  const r = await api("GET", `/api/stores/${storeId}/products?page=1`);
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 20);
  const first = r.body.products[0];
  assert.equal(first.id, "5000");
  assert.equal(first.price, null);
  assert.equal(r.body.location_required, true);
  assert.equal(first.variants.length, 2);
  assert.equal(first.variants[0].title, "Red");
  assert.equal(first.images.length, 1);
});

test("zones are read and mapped with their ids and names", async () => {
  const r = await api("GET", `/api/stores/${storeId}/zones`);
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 48);
  assert.equal(r.body.zones[0].id, 100);
  assert.equal(r.body.zones[0].name, "Zone 1");
});

test("zone filter is sent as the zone parameter", async () => {
  const r = await api("GET", `/api/stores/${storeId}/products?page=1&zone=100`);
  assert.ok(r.body.products.length > 0);
  assert.ok(r.body.products.every((p) => p.id && p.price));
});

test("delivery settings: no parameter name is assumed; discovery sets it", async () => {
  let r = await api("PUT", `/api/stores/${storeId}/delivery-settings`, { mode: "outlet", remember_area: true });
  assert.equal(r.body.context_param, null);
  r = await api("PUT", `/api/stores/${storeId}/delivery-settings`, { mode: "zone" });
  assert.equal(r.body.context_param, null);
  r = await api("PUT", `/api/stores/${storeId}/delivery-settings`, { mode: "shipping" });
  assert.equal(r.status, 422);
});

test("test run: passes the checks on the mock and makes no write calls", async () => {
  await api("PUT", `/api/stores/${storeId}/endpoints/order`, { path: "/orders/:number" });
  await api("PUT", `/api/stores/${storeId}/endpoints/search`, { path: "/search?q=:query" });
  mock.requests.length = 0;
  const r = await api("POST", `/api/stores/${storeId}/test-runs`, { phone: "01700000000" });
  assert.equal(r.status, 200);
  const check = (label) => r.body.checks.find((c) => c.label === label);
  assert.equal(check("Store profile").state, "passed");
  assert.equal(check("Catalog").state, "passed");
  assert.equal(check("Live stock and price").state, "passed");
  assert.equal(check("Order lookup").state, "passed");
  assert.equal(check("Order details").state, "passed");
  assert.equal(check("Update order").state, "not_supported");
  assert.equal(r.body.can_continue, true);
  const dq = (label) => r.body.data_quality.find((c) => c.label === label);
  assert.equal(dq("Prices are numbers").state, "pass");
  assert.equal(dq("Stock present").state, "pass");
  assert.equal(dq("Variants have their own stock").state, "pass");
  assert.equal(dq("Images load").state, "pass");
  assert.equal(dq("All pages load").state, "pass");
  assert.ok(r.body.sample_products.length > 0 && r.body.sample_products.length <= 3);
  assert.equal(mock.requests.some((x) => ["POST", "PUT", "PATCH", "DELETE"].includes(x.method)), false);
});

test("the test phone is never stored", async () => {
  const onDisk = fs.readFileSync(path.join(dataDir, "stores.json"), "utf8");
  assert.equal(onDisk.includes("01700000000"), false);
  const latest = await api("GET", `/api/stores/${storeId}/test-runs/latest`);
  assert.equal(latest.body.phone, "••••00");
});

test("a store without a catalog cannot continue", async () => {
  const s = await api("POST", "/api/stores", { delivery_mode: "zone", name: "Empty", base_url: mockBase, auth: { mode: "key", key: KEY_BAD } });
  const r = await api("POST", `/api/stores/${s.body.id}/test-runs`, {});
  assert.equal(r.body.can_continue, false);
  assert.equal(r.body.checks.find((c) => c.label === "Catalog").state, "failed");
});

test("Store Type is required: a store without zone or outlet is refused", async () => {
  const r = await api("POST", "/api/stores", { name: "No type", base_url: mockBase, auth: { mode: "none" } });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, "delivery_mode_required");
  const o = await api("POST", "/api/stores", { delivery_mode: "outlet", name: "Outlet", base_url: mockBase, auth: { mode: "none" } });
  assert.equal(o.body.delivery.mode, "outlet");
  assert.equal(o.body.delivery.context_param, null);
});
