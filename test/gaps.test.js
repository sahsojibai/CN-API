"use strict";
// Spec gaps for Map my existing API: zone-less stores, paging styles, order and customer tabs,
// status value maps, coalesce fallback, extra fields.
process.env.ALLOW_PRIVATE_HOSTS = "1";
process.env.CHATTRN_SECRET = "test-secret-for-the-suite-only";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../src/server");
const { createMockServer, KEY, PREFIX } = require("../src/mock-store");
const M = require("../src/mapping");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function startStack(mockOpts) {
  const mock = createMockServer(mockOpts);
  const mockPort = await listen(mock.server);
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "chattrn-gaps-")), publicDir: path.join(__dirname, "..", "public") });
  const port = await listen(app.server);
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const create = async () => (await api("POST", "/api/stores", {
    delivery_mode: "zone",
    name: "Gap store", base_url: `http://127.0.0.1:${mockPort}${PREFIX}`, currency: "BDT",
    auth: { mode: "key", header: "X-API-Key", key: KEY },
  })).body.id;
  const close = () => { mock.server.close(); app.server.close(); };
  return { api, create, close, mock, app };
}

// Saves the product mapping (updated_at marked as not in the store).
async function saveProductMapping(api, id, extras) {
  const p = await api("POST", `/api/stores/${id}/mapping/propose`, { resource: "product" });
  const rows = p.body.rows.map((x) => ({ key: x.key, source_path: x.source_path, state: x.state, not_in_store: x.key === "updated_at" || undefined }));
  return api("PUT", `/api/stores/${id}/mapping`, { resource: "product", rows, extras });
}

test("zone-less store: the products check says a zone is needed and uses the first zone", async () => {
  const s = await startStack({ zoneRequired: true });
  try {
    const id = await s.create();
    let r = await s.api("POST", `/api/stores/${id}/endpoints/products/check`, {});
    assert.equal(r.body.state, "needs_attention");
    assert.match(r.body.message, /without a zone or outlet/);
    assert.match(r.body.message, /zone 100/);

    // Choose the zone in Delivery setup: every product call now sends it.
    r = await s.api("PUT", `/api/stores/${id}/delivery-settings`, { mode: "zone", zone: "100" });
    assert.equal(r.body.zone_value, "100");
    r = await s.api("POST", `/api/stores/${id}/endpoints/products/check`, {});
    assert.equal(r.body.state, "responded");
    assert.equal(r.body.summary, "200 · 13 products per page");

    r = await s.api("GET", `/api/stores/${id}/zones`);
    assert.equal(r.body.chosen, "100");
  } finally { s.close(); }
});

test("zone-less store with no zones at all says to pick a zone", async () => {
  const s = await startStack({ zoneRequired: true });
  try {
    const id = await s.create();
    await s.api("PUT", `/api/stores/${id}/delivery-settings`, { mode: "zone", zone: null });
    const r = await s.api("POST", `/api/stores/${id}/endpoints/products/check`, {});
    assert.equal(r.body.state, "needs_attention");
    assert.ok(r.body.message.length > 0);
  } finally { s.close(); }
});

for (const style of ["link", "cursor", "offset"]) {
  test(`paging: ${style} is detected and the test run reads all 30 pages`, async () => {
    const s = await startStack({ paging: style });
    try {
      const id = await s.create();
      const r = await s.api("POST", `/api/stores/${id}/endpoints/products/check`, {});
      assert.equal(r.body.state, "responded");
      const store = (await s.api("GET", `/api/stores/${id}`)).body;
      assert.equal(store.paging.style, style);
      const run = await s.api("POST", `/api/stores/${id}/test-runs`, {});
      const pages = run.body.data_quality.find((c) => c.label === "All pages load");
      assert.equal(pages.state, "pass", pages.message);
      assert.match(pages.message, /Page 1 to 30 read/);
    } finally { s.close(); }
  });
}

test("order tab: unmapped statuses block save; mapped statuses show as Chattrn statuses", async () => {
  const s = await startStack({});
  try {
    const id = await s.create();
    await s.api("PUT", `/api/stores/${id}/endpoints/orders`, { path: "/orders?phone=:phone" });
    await s.api("PUT", `/api/stores/${id}/endpoints/order`, { path: "/orders/:number" });
    await s.api("GET", `/api/stores/${id}/orders?phone=01700000000`);
    const p = await s.api("POST", `/api/stores/${id}/mapping/propose`, { resource: "order" });
    assert.equal(p.status, 200);
    const row = (k) => p.body.rows.find((x) => x.key === k);
    assert.equal(row("id").source_path, "id");
    assert.equal(row("number").source_path, "orderNumber");
    assert.equal(row("status").source_path, "status");
    assert.equal(row("total").source_path, "totalPrice");

    const rows = p.body.rows.map((x) => ({ ...x, value_map: x.key === "status" ? { shipped: "Shipped" } : undefined }));
    let r = await s.api("PUT", `/api/stores/${id}/mapping`, { resource: "order", rows });
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /processing/);

    rows.find((x) => x.key === "status").value_map = { shipped: "Shipped", processing: "Confirmed" };
    r = await s.api("PUT", `/api/stores/${id}/mapping`, { resource: "order", rows });
    assert.equal(r.status, 200);

    const orders = await s.api("GET", `/api/stores/${id}/orders?phone=01700000000`);
    assert.equal(orders.body.orders[0].status, "Shipped");
    assert.equal(orders.body.orders[1].status, "Confirmed", "processing shows as Confirmed, not Shipped");
    assert.equal(orders.body.orders[1].raw_status, "processing");
    assert.equal(orders.body.orders[0].total, "450.00");
    assert.equal(JSON.stringify(orders.body).includes("Test"), false, "customer name is never copied");
  } finally { s.close(); }
});

test("order status values must be Chattrn statuses", async () => {
  const s = await startStack({});
  try {
    const id = await s.create();
    await s.api("PUT", `/api/stores/${id}/endpoints/orders`, { path: "/orders?phone=:phone" });
    await s.api("GET", `/api/stores/${id}/orders?phone=01700000000`);
    const p = await s.api("POST", `/api/stores/${id}/mapping/propose`, { resource: "order" });
    const rows = p.body.rows.map((x) => ({ ...x, value_map: x.key === "status" ? { shipped: "Shipped", processing: "Working" } : undefined }));
    const r = await s.api("PUT", `/api/stores/${id}/mapping`, { resource: "order", rows });
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /isn't a Chattrn status/);
  } finally { s.close(); }
});

test("customer tab: matched and never copied", async () => {
  const s = await startStack({});
  try {
    const id = await s.create();
    await s.api("PUT", `/api/stores/${id}/endpoints/orders`, { path: "/orders?phone=:phone" });
    await s.api("GET", `/api/stores/${id}/orders?phone=01700000000`);
    const p = await s.api("POST", `/api/stores/${id}/mapping/propose`, { resource: "customer" });
    assert.equal(p.body.rows.find((x) => x.key === "phone").source_path, "phone");
    const r = await s.api("PUT", `/api/stores/${id}/mapping`, { resource: "customer", rows: p.body.rows });
    assert.equal(r.status, 200);
    const g = await s.api("GET", `/api/stores/${id}/mapping?resource=customer`);
    assert.equal(g.body.never_copied, true);
  } finally { s.close(); }
});

test("extra fields are kept under x_chattrn with their label", async () => {
  const s = await startStack({});
  try {
    const id = await s.create();
    await s.api("POST", `/api/stores/${id}/endpoints/products/check`, {});
    let r = await saveProductMapping(s.api, id, [{ source_path: "brand", label: "Brand name", enabled: true }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.extras[0].label, "Brand name");
    const products = await s.api("GET", `/api/stores/${id}/products?page=1`);
    assert.equal(products.body.products[0].x_chattrn["Brand name"], "MockBrand");
    r = await saveProductMapping(s.api, id, [{ source_path: "notAField", label: "x" }]);
    assert.equal(r.status, 422);
  } finally { s.close(); }
});

test("coalesce: a missing primary field falls back to its fallback path", () => {
  const store = {
    currency: "BDT",
    samples: { product: [{ productId: 1, productName: "A", sellPrice: "90.00", totalStock: 3 }] },
    mapping: {
      product: {
        current: 1,
        versions: [{
          version: 1,
          rows: [
            { key: "id", source_path: "productId" },
            { key: "title", source_path: "productName" },
            { key: "price", source_path: "discountPrice", fallback_path: "sellPrice" },
            { key: "stock", source_path: "totalStock" },
          ],
        }],
      },
    },
  };
  const p = M.toProduct(store, { productId: 1, productName: "A", sellPrice: "90.00", totalStock: 3 });
  assert.equal(p.price, "90.00");
  const p2 = M.toProduct(store, { productId: 1, productName: "A", discountPrice: "75", sellPrice: "90.00", totalStock: 3 });
  assert.equal(p2.price, "75.00");
});

test("zone-less store: the test run fails the catalog until a zone is chosen", async () => {
  const s = await startStack({ zoneRequired: true });
  try {
    const id = await s.create();
    const run = await s.api("POST", `/api/stores/${id}/test-runs`, {});
    assert.equal(run.body.checks.find((c) => c.label === "Catalog").state, "failed");
    assert.equal(run.body.can_continue, false);
  } finally { s.close(); }
});
