"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../src/chattrn-connector");
const { runChattrnTests } = require("../src/chattrn-test-runner");

test("verification distinguishes advertised cancellation and diagnoses missing mappings", async (t) => {
  let title = "Phone";
  const product = () => ({ id: 1, title, variants: [{ id: 2, price: "20.00", inventory_quantity: 3 }], images: [] });
  t.mock.method(C, "getStore", async () => ({ res: { http: 200 }, body: { api_version: "2026-10", country_code: "BD", name: "Store", currency: "BDT", delivery_mode: "outlet", capabilities: { products: true, orders_read: false, customers_search: false, draft_orders: false, orders_cancel: true } } }));
  t.mock.method(C, "countProducts", async () => ({ res: { http: 200 }, count: 1 }));
  t.mock.method(C, "listProducts", async () => ({ res: { http: 200 }, list: [product()] }));
  t.mock.method(C, "searchProducts", async () => ({ res: { http: 200 }, list: [product()] }));
  t.mock.method(C, "getProduct", async () => ({ res: { http: 200, ms: 10 }, body: product() }));
  const run = await runChattrnTests({}, { chattrn: {} });
  assert.equal(run.checks.find(c => c.label === "Cancel order").state, "capability_only");
  assert.equal(run.summary.capability_only, 1);
  assert.doesNotMatch(run.checks.find(c => c.label === "Catalog").message, /images/);
  assert.equal(run.can_continue, true);
  assert.equal(run.checks.find(c => c.label === "Update order").state, "not_supported");
  title = null;
  const broken = await runChattrnTests({}, { chattrn: {} });
  assert.equal(broken.can_continue, false);
  assert.equal(broken.fields_understood.find(f => f.chattrn === "product.title").state, "missing");
  assert.match(broken.checks.find(c => c.label === "Catalog").message, /Product name/);
});

function setup(t, { badProfile = false, brokenStock = false, paginationFailure = false, draft = false } = {}) {
  const product = { id: 1, title: "Phone", variants: [{ id: 2, price: "20.00", inventory_quantity: 3 }], images: [] };
  t.mock.method(C, "getStore", async () => ({ res: { http: 200 }, body: { api_version: badProfile ? "unsupported" : "2026-10", country_code: "BD", name: "Store", currency: "BDT", delivery_mode: "outlet", capabilities: { products: true, orders_read: false, draft_orders: draft } } }));
  t.mock.method(C, "countProducts", async () => ({ res: { http: 200 }, count: 1 }));
  t.mock.method(C, "listProducts", async (_ctx, _store, opts) => opts.next
    ? { res: { http: 503 }, list: [] }
    : { res: { http: 200 }, list: [product], next: paginationFailure ? "https://store.test/products.json?page=2" : null });
  t.mock.method(C, "searchProducts", async () => ({ res: { http: 200 }, list: [product] }));
  t.mock.method(C, "getProduct", async () => ({ res: { http: brokenStock ? 503 : 200, ms: 1 }, body: brokenStock ? null : product }));
}
test("unsupported profiles and failed stock reads block continuation", async t => {
  setup(t, { brokenStock: true });
  const run = await runChattrnTests({}, { chattrn: {} });
  assert.equal(run.can_continue, false);
  assert.equal(run.checks.find(c => c.label === "Live stock and price").state, "needs_attention");
});
test("unsupported API version never passes profile validation", async t => {
  setup(t, { badProfile: true });
  const run = await runChattrnTests({}, { chattrn: {} });
  assert.equal(run.checks[0].state, "failed");
  assert.equal(run.can_continue, false);
});
test("failed subsequent catalog page is not reported as complete", async t => {
  setup(t, { paginationFailure: true });
  const run = await runChattrnTests({}, { chattrn: {} });
  assert.equal(run.data_quality.find(c => c.label === "All pages load").state, "warning");
  assert.equal(run.can_continue, false);
});
test("default verification never writes; empty sandbox draft cannot pass", async t => {
  setup(t, { draft: true });
  const CL = require("../src/chattrn-client");
  let writes = 0;
  t.mock.method(CL, "call", async () => { writes++; return { http: 201, json: {} }; });
  const normal = await runChattrnTests({}, { chattrn: {} });
  assert.equal(writes, 0);
  assert.equal(normal.checks.find(c => c.label === "Cart quote").state, "not_run");
  const sandbox = await runChattrnTests({}, { chattrn: {} }, { allow_test_writes: true });
  assert.equal(writes, 1);
  assert.equal(sandbox.checks.find(c => c.label === "Cart quote").state, "needs_attention");
});
test("flat personal data is redacted and malformed prices stay missing", () => {
  const M = require("../src/mapping");
  const clean = M.redact({ phone: 123456, email: "buyer@example.test", address: "Home", customer: { phone: 123 }, id: 9 });
  assert.equal(clean.phone, "•••"); assert.equal(clean.email, "•••"); assert.equal(clean.address, "•••");
  assert.equal(clean.customer.phone, "•••"); assert.equal(clean.id, 9);
  assert.equal(M.toMoney("not a price"), null); assert.equal(M.toMoney("0"), "0.00");
});

test("native HTTP flow verifies both catalog pages without merchant writes", async () => {
  process.env.ALLOW_PRIVATE_HOSTS = "1";
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { createApp } = require("../src/server");
  const { createMockChattrnStore } = require("../src/mock-chattrn-store");
  const merchant = createMockChattrnStore();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-correctness-"));
  const app = createApp({ dataDir, publicDir: path.join(__dirname, "../public") });
  const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
  const site = await listen(merchant.server);
  const base = await listen(app.server);
  try {
    const created = await fetch(base + "/api/stores", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Native", brand: "Brand A", connection_type: "chattrn_api", delivery_mode: "zone", base_url: site + merchant.PREFIX, access_token: merchant.TOKEN }) });
    assert.equal(created.status, 201);
    const { id } = await created.json();
    const post = route => fetch(`${base}/api/stores/${id}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal((await post("activate")).status, 409, "review cannot be bypassed");
    assert.equal((await post("onboarding/review")).status, 200);
    assert.equal((await post("activate")).status, 409, "verification cannot be bypassed");
    const response = await fetch(`${base}/api/stores/${id}/test-runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 200);
    const run = await response.json();
    assert.equal(run.can_continue, true, JSON.stringify(run.checks));
    assert.equal((await post("activate")).status, 200, "current reviewed verification activates");
    await fetch(`${base}/api/stores/${id}/delivery-settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({mode:"outlet"}) });
    assert.equal((await post("activate")).status, 409, "changing configuration invalidates verification");
    assert.match(run.data_quality.find(c => c.label === "All pages load").message, /60 products across 2 page/);
    assert.equal(merchant.requests.filter(r => r.method !== "GET" && r.method !== "HEAD").length, 0);
  } finally {
    app.server.closeAllConnections(); merchant.server.closeAllConnections();
    await Promise.all([new Promise(resolve => app.server.close(resolve)), new Promise(resolve => merchant.server.close(resolve))]);
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.ALLOW_PRIVATE_HOSTS;
  }
});
