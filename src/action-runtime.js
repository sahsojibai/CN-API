"use strict";

const { randomUUID } = require("node:crypto");
const CL = require("./chattrn-client");
const SC = require("./store-client");

// Standard actions are deliberately small and declarative. They describe the
// canonical Chattrn API; the executor still checks the connected store's
// advertised capability before making a request.
const STANDARD_ACTIONS = [
  { name: "Search products", method: "GET", path: "/products/search.json", capability: "products", risk: "Low", inputs: [{ name: "q", sent_as: "query", required: true }, { name: "limit", sent_as: "query" }] },
  { name: "Product details", method: "GET", path: "/products/{id}.json", capability: "products", risk: "Low", inputs: [{ name: "id", sent_as: "path", required: true }] },
  { name: "Check stock", method: "GET", path: "/inventory_levels.json", capability: "inventory_levels", risk: "Low", inputs: [{ name: "inventory_item_ids", sent_as: "query" }, { name: "location_ids", sent_as: "query" }] },
  { name: "Find orders", method: "GET", path: "/orders.json", capability: "orders_read", risk: "Medium", inputs: [{ name: "status", sent_as: "query" }, { name: "customer_id", sent_as: "query" }] },
  { name: "Order details", method: "GET", path: "/orders/{id}.json", capability: "orders_read", risk: "Medium", inputs: [{ name: "id", sent_as: "path", required: true }] },
  { name: "Cancel order", method: "POST", path: "/orders/{id}/cancel.json", capability: "orders_cancel", risk: "High", inputs: [{ name: "id", sent_as: "path", required: true }, { name: "reason", sent_as: "body" }] },
  { name: "Add product to cart", runtime: "cart", operation: "add", method: "POST", path: "/draft_orders.json", capability: "draft_orders", risk: "High" },
  { name: "Change cart quantity", runtime: "cart", operation: "update", method: "POST", path: "/draft_orders.json", capability: "draft_orders", risk: "High" },
  { name: "Remove product from cart", runtime: "cart", operation: "remove", method: "POST", path: "/draft_orders.json", capability: "draft_orders", risk: "High" },
  { name: "Cart details", runtime: "cart_read", method: "GET", path: "/draft_orders.json", capability: "draft_orders", risk: "Low" },
  { name: "Checkout", method: "PUT", path: "/draft_orders/{id}/complete.json?payment_pending=true", capability: "draft_orders_complete", risk: "High", inputs: [{ name: "id", sent_as: "path", required: true }] },
];

function nativeStore(store) {
  return store.connection_type === "chattrn_api" || store.connection_type === "laravel_package";
}

function capabilityAvailable(store, action) {
  const caps = store.chattrn?.capabilities || {};
  return action.capability === "products" ? caps.products !== false : caps[action.capability] === true;
}

function listStandardActions(store) {
  return nativeStore(store) ? STANDARD_ACTIONS.filter((action) => capabilityAvailable(store, action)) : [];
}

function resolveAction(store, ref) {
  const wanted = String(ref || "");
  const custom = (Array.isArray(store.actions) ? store.actions : []).find((action) => action.id === wanted || action.name.toLowerCase() === wanted.toLowerCase());
  if (custom) return { ...custom, standard: false };
  const standard = listStandardActions(store).find((action) => action.name.toLowerCase() === wanted.toLowerCase());
  return standard ? { ...standard, standard: true } : null;
}

function inputValue(values, input) {
  if (Object.prototype.hasOwnProperty.call(values, input.name)) return values[input.name];
  if (input.source && Object.prototype.hasOwnProperty.call(values, input.source)) return values[input.source];
  return undefined;
}

function prepareRequest(action, values) {
  const supplied = values && typeof values === "object" ? values : {};
  const missing = [];
  const query = new URLSearchParams();
  const body = {};
  let path = action.path;
  for (const input of Array.isArray(action.inputs) ? action.inputs : []) {
    const value = inputValue(supplied, input);
    if (input.required && (value === undefined || value === null || String(value) === "")) missing.push(input.name);
    if (value === undefined || value === null || String(value) === "") continue;
    const sentAs = String(input.sent_as || input.in || "query").toLowerCase();
    if (sentAs === "path") {
      const encoded = encodeURIComponent(String(value));
      path = path.replace(new RegExp("\\{" + input.name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&") + "\\}|:" + input.name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&") + "(?=/|$)", "g"), encoded);
    } else if (sentAs === "body" || sentAs === "json") body[input.name] = value;
    else if (sentAs !== "header") query.set(input.name, String(value));
  }
  // Custom actions may have no input rows; pass explicitly supplied values in
  // a predictable way rather than silently dropping them.
  if (!Array.isArray(action.inputs) || !action.inputs.length) {
    if (action.method === "GET") Object.entries(supplied).forEach(([key, value]) => { if (value !== undefined && value !== null && String(value) !== "") query.set(key, String(value)); });
    else Object.assign(body, supplied);
  }
  const separator = path.includes("?") ? "&" : "?";
  return { path: query.toString() ? path + separator + query.toString() : path, body: action.method === "GET" ? undefined : body, missing };
}

function isWrite(action) { return action.method !== "GET" || action.risk === "High"; }

function sessionFor(store, id) {
  const sessions = store.runtime_sessions && typeof store.runtime_sessions === "object" ? store.runtime_sessions : {};
  const session = sessions[id];
  if (!session || session.expires_at <= new Date().toISOString()) return null;
  return session;
}

function newSession(store, { customer_id = null } = {}) {
  const now = new Date();
  const id = randomUUID();
  const session = { id, customer_id: customer_id ? String(customer_id) : null, cart: { draft_order_id: null, line_items: [], data: null }, idempotency: {}, created_at: now.toISOString(), expires_at: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString() };
  store.runtime_sessions = { ...(store.runtime_sessions || {}), [id]: session };
  return session;
}

async function executeAction(ctx, store, action, values, { confirm = false, idempotency_key = null } = {}) {
  if (!action || action.active === false) return { status: 404, code: "action_unavailable", message: "This action is not enabled." };
  if (action.standard && !capabilityAvailable(store, action)) return { status: 409, code: "capability_unavailable", message: `${action.name} is not supported by this store.` };
  if (isWrite(action) && !confirm) return { status: 409, code: "confirmation_required", message: "Customer confirmation is required before this action changes store data.", confirmation_required: true };
  const key = idempotency_key ? String(idempotency_key).slice(0, 200) : null;
  if (key && store.runtime_idempotency?.[key]) return { ...store.runtime_idempotency[key], replayed: true };
  const request = prepareRequest(action, values);
  if (request.missing.length) return { status: 422, code: "missing_action_inputs", message: `Missing required inputs: ${request.missing.join(", ")}.`, missing: request.missing };
  const response = nativeStore(store)
    ? await CL.call(ctx, store, { path: request.path, method: action.method, body: request.body })
    : await SC.call(ctx, store, { path: request.path, method: action.method, body: request.body });
  const result = { status: response.http >= 200 && response.http < 300 ? 200 : 502, ok: response.http >= 200 && response.http < 300, http: response.http, action: action.name, response: response.json || response.text || null };
  if (key) store.runtime_idempotency = { ...(store.runtime_idempotency || {}), [key]: result };
  return result;
}

function cartCapability(store) {
  return nativeStore(store) && store.chattrn?.capabilities?.draft_orders === true;
}

async function mutateCart(ctx, store, session, operation, input, { confirm = false, idempotency_key = null } = {}) {
  if (!cartCapability(store)) return { status: 409, code: "cart_unavailable", message: "This connected store does not advertise draft-order cart support." };
  if (!confirm) return { status: 409, code: "confirmation_required", message: "Customer confirmation is required before changing the cart.", confirmation_required: true };
  if (idempotency_key && store.runtime_idempotency?.[idempotency_key]) return { ...store.runtime_idempotency[idempotency_key], replayed: true };
  const value = input && typeof input === "object" ? input : {};
  let lineItems = Array.isArray(session.cart.line_items) ? session.cart.line_items.map((item) => ({ ...item })) : [];
  const item = value.item && typeof value.item === "object" ? value.item : value;
  const identity = item.variant_id != null ? `variant:${item.variant_id}` : item.custom_id != null ? `custom:${item.custom_id}` : null;
  const indexOf = () => lineItems.findIndex((line) => identity && (line.variant_id != null ? `variant:${line.variant_id}` : line.custom_id != null ? `custom:${line.custom_id}` : null) === identity);
  if (operation === "add") {
    if (!identity) return { status: 422, code: "cart_item_identity_required", message: "Provide variant_id for a product or custom_id for a custom item." };
    const quantity = Number(item.quantity || 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) return { status: 422, code: "cart_quantity", message: "Quantity must be a whole number from 1 to 999." };
    const index = indexOf();
    if (index >= 0 && value.merge !== false) lineItems[index].quantity = Number(lineItems[index].quantity || 0) + quantity;
    else lineItems.push({ ...item, quantity });
  } else if (operation === "update") {
    const index = indexOf(), quantity = Number(item.quantity);
    if (index < 0) return { status: 404, code: "cart_item_not_found", message: "That item is not in the cart." };
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) return { status: 422, code: "cart_quantity", message: "Quantity must be a whole number from 1 to 999." };
    lineItems[index].quantity = quantity;
  } else if (operation === "remove") {
    const index = indexOf();
    if (index < 0) return { status: 404, code: "cart_item_not_found", message: "That item is not in the cart." };
    lineItems.splice(index, 1);
  } else if (operation !== "replace") return { status: 422, code: "cart_operation", message: "Cart operation must be add, update, remove, or replace." };
  if (operation === "replace") lineItems = Array.isArray(value.line_items) ? value.line_items.slice(0, 100) : [];
  const draft = { line_items: lineItems };
  for (const key of ["note", "tags", "shipping_line", "applied_discount", "customer", "email", "shipping_address", "billing_address"]) if (value[key] !== undefined) draft[key] = value[key];
  const path = session.cart.draft_order_id ? `/draft_orders/${encodeURIComponent(session.cart.draft_order_id)}.json` : "/draft_orders.json";
  const response = await CL.call(ctx, store, { path, method: session.cart.draft_order_id ? "PUT" : "POST", body: { draft_order: draft } });
  const result = { status: response.http >= 200 && response.http < 300 ? 200 : 502, ok: response.http >= 200 && response.http < 300, http: response.http, operation, cart: response.json?.draft_order || null };
  if (result.ok && result.cart) session.cart = { draft_order_id: result.cart.id || session.cart.draft_order_id, line_items: Array.isArray(result.cart.line_items) ? result.cart.line_items : lineItems, data: result.cart };
  if (idempotency_key) store.runtime_idempotency = { ...(store.runtime_idempotency || {}), [idempotency_key]: result };
  return result;
}

async function completeCart(ctx, store, session, { confirm = false, idempotency_key = null } = {}) {
  if (!cartCapability(store) || !store.chattrn?.capabilities?.draft_orders_complete) return { status: 409, code: "checkout_unavailable", message: "This connected store does not advertise checkout support." };
  if (!confirm) return { status: 409, code: "confirmation_required", message: "Customer confirmation is required before placing the order.", confirmation_required: true };
  if (!session.cart.draft_order_id) return { status: 422, code: "cart_empty", message: "Add an item before checkout." };
  if (idempotency_key && store.runtime_idempotency?.[idempotency_key]) return { ...store.runtime_idempotency[idempotency_key], replayed: true };
  const response = await CL.call(ctx, store, { path: `/draft_orders/${encodeURIComponent(session.cart.draft_order_id)}/complete.json?payment_pending=true`, method: "PUT", body: { payment_pending: true } });
  const result = { status: response.http >= 200 && response.http < 300 ? 200 : 502, ok: response.http >= 200 && response.http < 300, http: response.http, order: response.json?.draft_order || response.json?.order || null };
  if (idempotency_key) store.runtime_idempotency = { ...(store.runtime_idempotency || {}), [idempotency_key]: result };
  return result;
}

async function executeSessionAction(ctx, store, session, action, values, options = {}) {
  if (!action || action.active === false) return { status: 404, code: "action_unavailable", message: "This action is not enabled." };
  if (action.standard && !capabilityAvailable(store, action)) return { status: 409, code: "capability_unavailable", message: `${action.name} is not supported by this store.` };
  if (action.runtime === "cart_read") return capabilityAvailable(store, action) ? { status: 200, ok: true, cart: session.cart } : { status: 409, code: "cart_unavailable", message: "This connected store does not advertise draft-order cart support." };
  if (action.runtime === "cart") return mutateCart(ctx, store, session, action.operation, values, options);
  if (action.name === "Checkout") return completeCart(ctx, store, session, options);
  return executeAction(ctx, store, action, values, options);
}

module.exports = { STANDARD_ACTIONS, listStandardActions, resolveAction, prepareRequest, newSession, sessionFor, executeAction, executeSessionAction, mutateCart, completeCart, isWrite };
