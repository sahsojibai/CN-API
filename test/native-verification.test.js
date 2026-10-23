"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../src/chattrn-connector");
const { runChattrnTests } = require("../src/chattrn-test-runner");

test("verification distinguishes advertised cancellation and diagnoses missing mappings", async (t) => {
  let title = "Phone";
  const product = () => ({ id: 1, title, variants: [{ id: 2, price: "20.00", inventory_quantity: 3 }], images: [] });
  t.mock.method(C, "getStore", async () => ({ res: { http: 200 }, body: { name: "Store", currency: "BDT", delivery_mode: "outlet", capabilities: { orders_read: false, customers_search: false, draft_orders: false, orders_cancel: true } } }));
  t.mock.method(C, "countProducts", async () => ({ count: 1 }));
  t.mock.method(C, "listProducts", async () => ({ list: [product()] }));
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
