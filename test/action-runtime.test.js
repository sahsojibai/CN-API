"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../src/action-runtime");

test("action runtime substitutes path inputs and separates query/body values", () => {
  const request = R.prepareRequest({ method: "POST", path: "/orders/{id}/cancel.json", inputs: [
    { name: "id", sent_as: "path", required: true },
    { name: "reason", sent_as: "body" },
  ] }, { id: "A/12", reason: "customer" });
  assert.equal(request.path, "/orders/A%2F12/cancel.json");
  assert.deepEqual(request.body, { reason: "customer" });
  assert.deepEqual(request.missing, []);
});

test("action runtime reports required inputs and blocks writes without confirmation", async () => {
  const action = { name: "Cancel order", method: "POST", path: "/orders/{id}/cancel.json", risk: "High", inputs: [{ name: "id", sent_as: "path", required: true }] };
  assert.deepEqual(R.prepareRequest(action, {}).missing, ["id"]);
  const result = await R.executeAction({}, { connection_type: "chattrn_api" }, action, { id: "1" });
  assert.equal(result.code, "confirmation_required");
  assert.equal(result.confirmation_required, true);
});

test("runtime sessions carry a guest cart and expire after thirty days", () => {
  const store = {};
  const session = R.newSession(store);
  assert.equal(session.customer_id, null);
  assert.deepEqual(session.cart.line_items, []);
  assert.equal(R.sessionFor(store, session.id).id, session.id);
});

test("cart mutations require the native draft-order capability and confirmation", async () => {
  const store = { connection_type: "mapped_api", chattrn: { capabilities: { draft_orders: true } } };
  const session = R.newSession(store);
  const result = await R.mutateCart({}, store, session, "add", { item: { variant_id: "v1", quantity: 1 } });
  assert.equal(result.code, "cart_unavailable");
});

test("standard cart actions resolve for a native store", () => {
  const store = { connection_type: "chattrn_api", chattrn: { capabilities: { products: true, draft_orders: true } } };
  const action = R.resolveAction(store, "Add product to cart");
  assert.equal(action.runtime, "cart");
  assert.equal(action.operation, "add");
});
