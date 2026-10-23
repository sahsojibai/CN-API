"use strict";
// Field mapping: match a store's own field names to Chattrn fields, validate the match
// against real sample values, save versions, and convert raw records to the canonical model.
// Matching is rules-only (synonyms + value checks). The AI fallback from the spec is not built.
const { HttpError } = require("./http");

const MONEY = /^\d+(\.\d+)?$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const depth = (path) => path.split(".").length;

// level: required | recommended | optional. Matching uses the normalised name (lowercase, letters and digits only).
const FIELDS = {
  product: [
    { key: "id", label: "Product ID", chattrn: "product.id", level: "required", type: "scalar", syn: ["id", "productid", "product_id", "productno"] },
    { key: "title", label: "Title", chattrn: "product.title", level: "required", type: "text", syn: ["title", "name", "productname", "product_name"] },
    { key: "price", label: "Selling price", chattrn: "product.price", level: "required", type: "money", syn: ["price", "sellprice", "saleprice", "sellingprice", "currentprice", "unitprice"] },
    { key: "compare_at_price", label: "Was price", chattrn: "product.compare_at_price", level: "optional", type: "money", syn: ["compareprice", "compareatprice", "wasprice", "originalprice", "listprice", "msrp", "regularprice"] },
    { key: "currency", label: "Currency", chattrn: "product.currency", level: "recommended", type: "text", syn: ["currency", "currencycode"] },
    { key: "stock", label: "Total stock", chattrn: "product.stock", level: "required", type: "number", syn: ["stock", "totalstock", "quantity", "qty", "inventory", "inventoryquantity", "stockquantity", "stocklevel", "availablequantity"] },
    { key: "images", label: "Image", chattrn: "product.images", level: "recommended", type: "image", syn: ["images", "image", "imageurl", "thumbnail", "photo", "picture"] },
    { key: "updated_at", label: "Updated at", chattrn: "product.updated_at", level: "required", type: "iso", syn: ["updatedat", "modifiedat", "lastupdated"] },
    { key: "vendor", label: "Brand / vendor", chattrn: "product.vendor", level: "optional", type: "text", syn: ["vendor", "brand", "manufacturer"] },
    { key: "variants", label: "Variants list", chattrn: "product.variants", level: "recommended", type: "array", syn: ["variants", "variations", "options"] },
  ],
  variant: [
    { key: "id", label: "Variant ID", chattrn: "variant.id", level: "required", type: "scalar", syn: ["id", "variantid", "variant_id"] },
    { key: "title", label: "Variant title", chattrn: "variant.title", level: "required", type: "text", syn: ["title", "name", "variantname", "label", "optionvalue", "optiontitle"] },
    { key: "price", label: "Variant price", chattrn: "variant.price", level: "required", type: "money", syn: ["price", "sellprice", "saleprice", "unitprice"] },
    { key: "compare_at_price", label: "Variant was price", chattrn: "variant.compare_at_price", level: "optional", type: "money", syn: ["compareprice", "compareatprice", "wasprice"] },
    { key: "stock", label: "Variant stock", chattrn: "variant.inventory_quantity", level: "required", type: "number", syn: ["stock", "stockqty", "inventoryquantity", "qty", "quantity", "variantstock", "stocklevel"] },
    { key: "sku", label: "SKU", chattrn: "variant.sku", level: "optional", type: "text", syn: ["sku", "code"] },
  ],
  zone: [
    { key: "id", label: "Zone ID", chattrn: "location.id (sent as the zone parameter)", level: "required", type: "scalar", syn: ["zoneid", "zone_id", "id", "code", "areaid", "locationid"] },
    { key: "name", label: "Zone name", chattrn: "location.name", level: "required", type: "text", syn: ["zonename", "name", "title", "area", "zone", "zonelabel"] },
  ],
  order: [
    { key: "id", label: "Order ID", chattrn: "order.id", level: "required", type: "scalar", syn: ["id", "orderid", "order_id"] },
    { key: "number", label: "Order number", chattrn: "order.name", level: "required", type: "scalar", syn: ["ordernumber", "number", "name", "orderno", "reference", "orderref"] },
    { key: "status", label: "Order status", chattrn: "order.status (mapped to Chattrn statuses)", level: "required", type: "text", syn: ["status", "orderstatus", "state", "fulfillmentstatus"] },
    { key: "total", label: "Order total", chattrn: "order.total_price", level: "required", type: "money", syn: ["total", "totalprice", "grandtotal", "amount", "ordertotal"] },
    { key: "currency", label: "Currency", chattrn: "order.currency", level: "recommended", type: "text", syn: ["currency", "currencycode"] },
    { key: "created_at", label: "Placed at", chattrn: "order.created_at", level: "recommended", type: "iso", syn: ["createdat", "orderdate", "placedat"] },
    { key: "items", label: "Line items", chattrn: "order.line_items", level: "recommended", type: "array", syn: ["items", "lineitems", "line_items", "orderitems"] },
  ],
  // Never copied: the customer is only used to find orders. Stored fields are not kept.
  customer: [
    { key: "id", label: "Customer ID", chattrn: "customer.id", level: "required", type: "scalar", syn: ["id", "customerid", "customer_id"] },
    { key: "phone", label: "Phone", chattrn: "customer.phone", level: "required", type: "text", syn: ["phone", "phonenumber", "mobile", "contact"] },
    { key: "first_name", label: "First name", chattrn: "customer.first_name", level: "optional", type: "text", syn: ["firstname", "first_name", "givenname"] },
    { key: "last_name", label: "Last name", chattrn: "customer.last_name", level: "optional", type: "text", syn: ["lastname", "last_name", "surname"] },
  ],
};

// Keep diagnostic field names while masking common personal fields and customer containers.
// Custom merchant-specific personal fields still require explicit schema-aware handling.
const PII_KEYS = /^(customer|buyer|billing|shipping|shipping_address|billing_address|contact|phone|phone_number|mobile|email|email_address|address|address1|address2|first_name|last_name|full_name|name)$/i;
function maskAll(v) {
  if (Array.isArray(v)) return v.map(maskAll);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "string" ? "•••" : maskAll(x)]));
  return v == null ? v : "•••";
}
function redact(obj) {
  if (Array.isArray(obj)) return obj.map(redact);
  if (!isObj(obj)) return obj;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, PII_KEYS.test(k) ? maskAll(v) : redact(v)]));
}

// Chattrn's order statuses. A store's raw order statuses must map to one of these.
const CANON_STATUS = ["Pending", "Confirmed", "Shipped", "Delivered", "Cancelled"];

const RESOURCES = Object.keys(FIELDS);

function kindOf(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string") return MONEY.test(v) ? "decimal" : ISO.test(v) ? "iso" : "string";
  return "other";
}

// Flat list of leaf fields. Arrays are reported once, with their first element; their contents are not descended into.
function leaves(obj, prefix = "") {
  const out = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const path = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) out.push({ path, name: k, kind: "array", value: v.length ? v[0] : null, count: v.length });
    else if (isObj(v)) out.push(...leaves(v, path));
    else out.push({ path, name: k, kind: kindOf(v), value: v });
  }
  return out;
}

function typeOkLeaf(type, leaf) {
  const v = leaf.value;
  if (leaf.kind === "array") return type === "array" || type === "image";
  if (v === null || v === undefined) return true; // empty in the sample: allowed, the mapping still reads it
  switch (type) {
    case "money": return typeof v === "number" || (typeof v === "string" && MONEY.test(v.trim()));
    case "number": return typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v.trim()));
    case "iso": return typeof v === "string" && ISO.test(v);
    case "text": return typeof v === "string";
    case "scalar": return typeof v === "string" || typeof v === "number";
    case "image": return typeof v === "string";
    default: return true;
  }
}

function getPath(obj, path) {
  if (!path) return undefined;
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function short(v) {
  const s = isObj(v) || Array.isArray(v) ? JSON.stringify(v) : String(v);
  return s.length > 60 ? s.slice(0, 60) + "…" : s;
}

// Returns the rows for a resource: the match rules proposed from the sample, not stored.
function propose(resource, sample) {
  const defs = FIELDS[resource];
  if (!defs) throw new HttpError(400, "unknown_resource", `Unknown resource "${resource}".`);
  const cands = leaves(sample);
  const rows = defs.map((def) => {
    const ranked = cands
      .map((c) => ({ c, rank: def.syn.indexOf(norm(c.name)) }))
      .filter(({ c, rank }) => rank >= 0 && typeOkLeaf(def.type, c))
      .sort((a, b) => depth(a.c.path) - depth(b.c.path) || a.rank - b.rank);
    if (!ranked.length) {
      return rowOf(def, null, { state: def.level === "required" ? "missing" : "optional" });
    }
    const best = ranked[0];
    const tie = ranked.filter(({ c, rank }) => rank === best.rank && depth(c.path) === depth(best.c.path));
    if (tie.length > 1) {
      const paths = tie.map((t) => t.c.path);
      return rowOf(def, best.c.path, {
        state: "check_this",
        sample: short(best.c.value),
        candidates: paths,
        question: `Which field is ${def.label.toLowerCase()}? ${paths.join(" or ")}`,
      });
    }
    return rowOf(def, best.c.path, {
      state: "matched",
      sample: short(best.c.value),
      candidates: ranked.map((t) => t.c.path),
    });
  });
  return { resource, rows };
}

function rowOf(def, source_path, extra) {
  return { key: def.key, chattrn: def.chattrn, label: def.label, level: def.level, type: def.type, source_path, ...extra };
}

// The sample used to match a resource. Variant samples come from inside the first product's variants list.
function sampleFor(store, resource) {
  if (resource === "product") return store.samples?.product?.[0] || null;
  if (resource === "zone") return store.samples?.zone?.[0] || null;
  if (resource === "order") return store.samples?.orders?.[0] || null;
  if (resource === "customer") {
    const c = store.samples?.orders?.[0]?.customer;
    return isObj(c) ? c : null;
  }
  if (resource === "variant") {
    const p = store.samples?.product?.[0];
    if (!p) return null;
    const vr = currentRows(store, "product").find((r) => r.key === "variants" && r.source_path);
    const arr = vr ? getPath(p, vr.source_path) : null;
    return Array.isArray(arr) && isObj(arr[0]) ? arr[0] : null;
  }
  return null;
}

// Saved rows of the current version, or the proposal when nothing is saved yet.
function currentRows(store, resource) {
  const m = store.mapping?.[resource];
  if (m && m.current) {
    const v = m.versions.find((x) => x.version === m.current);
    if (v) return v.rows;
  }
  const sample = sampleFor(store, resource);
  return sample ? propose(resource, sample).rows : [];
}

function isSaved(store, resource) {
  const m = store.mapping?.[resource];
  return !!(m && m.current);
}

function stateFor(def, row) {
  if (row.source_path) return "matched";
  if (def.level !== "required") return "optional";
  return row.not_in_store && def.key === "updated_at" ? "optional" : "missing";
}

function distinctStatuses(store, sourcePath) {
  const seen = new Set();
  for (const o of store.samples?.orders || []) {
    const v = getPath(o, sourcePath);
    if (v != null) seen.add(String(v));
  }
  return [...seen];
}

// Validates rows and extras from the client before they are saved. Returns {rows, extras}.
function normaliseRows(store, resource, rows, extras = []) {
  const defs = FIELDS[resource];
  if (!defs) throw new HttpError(400, "unknown_resource", `Unknown resource "${resource}".`);
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const sample = sampleFor(store, resource);
  const known = sample ? new Set(leaves(sample).map((l) => l.path)) : null;
  const checkPath = (p, label) => {
    if (p && known && !known.has(p)) throw new HttpError(422, "field_not_in_sample", `"${p}" isn't in the sample data for ${label}.`);
  };
  const out = [];
  for (const r of rows || []) {
    const def = byKey.get(r.key);
    if (!def) throw new HttpError(422, "unknown_field", `Unknown field "${r.key}".`);
    checkPath(r.source_path, def.label);
    checkPath(r.fallback_path, `${def.label} (fallback)`);
    if (r.state === "check_this" && r.source_path && !r.confirmed) {
      throw new HttpError(422, "unconfirmed", `Confirm which field is ${def.label.toLowerCase()} before saving.`);
    }
    let value_map = null;
    if (resource === "order" && def.key === "status" && r.source_path) {
      value_map = {};
      for (const [raw, canon] of Object.entries(r.value_map || {})) {
        if (!CANON_STATUS.includes(canon)) {
          throw new HttpError(422, "status_value", `"${canon}" isn't a Chattrn status. Use one of: ${CANON_STATUS.join(", ")}.`);
        }
        value_map[raw] = canon;
      }
      const unmapped = distinctStatuses(store, r.source_path).filter((s) => !(s in value_map));
      if (unmapped.length) {
        throw new HttpError(422, "unmapped_status", `Map these order statuses before saving: ${unmapped.join(", ")}.`);
      }
    }
    out.push({
      key: def.key,
      chattrn: def.chattrn,
      label: def.label,
      level: def.level,
      source_path: r.source_path || null,
      fallback_path: r.fallback_path || null,
      value_map,
      // Merchant confirmed the store has no such field (for example updated_at). Only allowed for updated_at.
      not_in_store: !r.source_path && r.not_in_store === true && def.key === "updated_at",
      state: stateFor(def, { source_path: r.source_path, not_in_store: r.not_in_store === true }),
    });
  }
  const missing = defs.filter(
    (d) => d.level === "required" && !out.some((o) => o.key === d.key && (o.source_path || o.not_in_store))
  );
  if (missing.length) {
    throw new HttpError(422, "required_fields", `Match these required fields first: ${missing.map((m) => m.label).join(", ")}.`);
  }
  const cleanExtras = [];
  if (resource === "product") {
    for (const e of extras || []) {
      if (!e || !e.source_path) continue;
      checkPath(e.source_path, "extra field");
      const label = String(e.label || e.source_path).trim().slice(0, 60);
      cleanExtras.push({ source_path: e.source_path, label, enabled: e.enabled !== false });
    }
  }
  return { rows: out, extras: cleanExtras };
}

function saveVersion(store, resource, rows, extras = []) {
  store.mapping = store.mapping || {};
  const m = store.mapping[resource] || { current: 0, versions: [] };
  const version = m.versions.reduce((mx, v) => Math.max(mx, v.version), 0) + 1;
  m.versions = [...m.versions, { version, rows, extras, saved_at: new Date().toISOString() }].slice(-20);
  m.current = version;
  store.mapping[resource] = m;
  return version;
}

function rollback(store, resource) {
  const m = store.mapping?.[resource];
  if (!m || !m.current) throw new HttpError(409, "nothing_saved", "No saved mapping to roll back.");
  const older = m.versions.filter((v) => v.version < m.current).map((v) => v.version);
  if (!older.length) throw new HttpError(409, "no_earlier_version", "There is no earlier version to roll back to.");
  m.current = Math.max(...older);
  return m.current;
}

// Field list for the "Your field" dropdown: compatible fields first, then all, with samples.
function fieldOptions(store, resource, compatibleWith) {
  const sample = sampleFor(store, resource);
  if (!sample) return [];
  const def = (FIELDS[resource] || []).find((f) => f.key === compatibleWith);
  return leaves(sample)
    .map((l) => ({ path: l.path, name: l.name, kind: l.kind, sample: short(l.value), compatible: def ? typeOkLeaf(def.type, l) : false }))
    .sort((a, b) => Number(b.compatible) - Number(a.compatible) || a.path.localeCompare(b.path));
}

// ---- Conversion to the canonical model ----

function toMoney(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v.toFixed(2) : null;
  if (typeof v === "string" && v.trim()) {
    const cleaned = v.trim().replace(/,/g, "");
    if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n.toFixed(2) : null;
  }
  return null;
}

function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function toImages(v) {
  if (typeof v === "string") return [v];
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x : x && (x.src || x.url || x.image)))
    .filter((x) => typeof x === "string");
}

// Reads one mapped field. Uses fallback_path when the primary is absent (coalesce).
function readRow(raw, row) {
  const v = getPath(raw, row.source_path);
  if ((v === undefined || v === null) && row.fallback_path) return getPath(raw, row.fallback_path);
  return v;
}

function currentVersion(store, resource) {
  const m = store.mapping?.[resource];
  if (!m || !m.current) return null;
  return m.versions.find((x) => x.version === m.current) || null;
}

function currentExtras(store, resource = "product") {
  return (currentVersion(store, resource)?.extras || []).filter((e) => e.enabled !== false);
}

function toVariant(store, x) {
  const o = { id: null, title: null, price: null, compare_at_price: null, stock: null, sku: null };
  for (const r of currentRows(store, "variant")) {
    if (!r.source_path) continue;
    const v = readRow(x, r);
    switch (r.key) {
      case "id": o.id = v == null ? null : String(v); break;
      case "title": o.title = v == null ? null : String(v); break;
      case "price": o.price = toMoney(v); break;
      case "compare_at_price": o.compare_at_price = toMoney(v); break;
      case "stock": o.stock = toNumber(v); break;
      case "sku": o.sku = v == null ? null : String(v); break;
    }
  }
  return o;
}

function toProduct(store, raw) {
  const rows = currentRows(store, "product");
  const out = {
    id: null, title: null, price: null, compare_at_price: null, currency: store.currency || null,
    stock: null, images: [], updated_at: null, vendor: null, variants: [],
  };
  for (const r of rows) {
    if (!r.source_path || r.key === "variants") continue;
    const v = readRow(raw, r);
    switch (r.key) {
      case "id": out.id = v == null ? null : String(v); break;
      case "title": out.title = v == null ? null : String(v); break;
      case "price": out.price = toMoney(v); break;
      case "compare_at_price": out.compare_at_price = toMoney(v); break;
      case "currency": if (v) out.currency = String(v).toUpperCase(); break;
      case "stock": out.stock = toNumber(v); break;
      case "images": out.images = toImages(v); break;
      case "updated_at": out.updated_at = v ?? null; break;
      case "vendor": out.vendor = v ?? null; break;
    }
  }
  const extras = currentExtras(store, "product");
  if (extras.length) {
    out.x_chattrn = Object.fromEntries(extras.map((e) => [e.label || e.source_path, getPath(raw, e.source_path) ?? null]));
  }
  const vr = rows.find((r) => r.key === "variants" && r.source_path);
  const arr = vr ? getPath(raw, vr.source_path) : null;
  if (Array.isArray(arr) && arr.length) out.variants = arr.filter(isObj).map((x) => toVariant(store, x));
  if (!out.variants.length) {
    out.variants = [{ id: out.id, title: "Default", price: out.price, compare_at_price: out.compare_at_price, stock: out.stock, sku: null, default: true }];
  }
  if (out.stock == null && out.variants.some((v) => v.stock != null)) {
    out.stock = out.variants.reduce((s, v) => s + (v.stock || 0), 0);
  }
  return out;
}

// Canonical order. The customer is never copied into the output.
function toOrder(store, raw) {
  const o = { id: null, number: null, status: null, raw_status: null, total: null, currency: store.currency || null, created_at: null, items_count: null };
  for (const r of currentRows(store, "order")) {
    if (!r.source_path) continue;
    const v = readRow(raw, r);
    switch (r.key) {
      case "id": o.id = v == null ? null : String(v); break;
      case "number": o.number = v == null ? null : String(v); break;
      case "status":
        o.raw_status = v == null ? null : String(v);
        o.status = r.value_map && v != null ? r.value_map[String(v)] ?? null : null;
        break;
      case "total": o.total = toMoney(v); break;
      case "currency": if (v) o.currency = String(v).toUpperCase(); break;
      case "created_at": o.created_at = v ?? null; break;
      case "items": o.items_count = Array.isArray(v) ? v.length : null; break;
    }
  }
  return o;
}

// Zones from the zones list, using the zone mapping (saved, or proposed from the first zone).
function zonesOf(store, list) {
  const rows = isSaved(store, "zone") ? currentRows(store, "zone") : list.length ? propose("zone", list[0]).rows : [];
  const idRow = rows.find((x) => x.key === "id" && x.source_path);
  const nameRow = rows.find((x) => x.key === "name" && x.source_path);
  return list.map((z) => ({
    id: idRow ? getPath(z, idRow.source_path) ?? null : null,
    name: nameRow ? getPath(z, nameRow.source_path) ?? null : null,
  }));
}

function sourcePathOf(store, resource, key) {
  return currentRows(store, resource).find((r) => r.key === key)?.source_path || null;
}

function idOf(r) {
  for (const k of ["id", "productId", "product_id", "productNo", "sku", "handle", "uuid"]) {
    if (r[k] != null) return r[k];
  }
  return null;
}

function titleOf(r) {
  for (const k of ["title", "name", "productName", "product_name", "label"]) {
    if (typeof r[k] === "string" && r[k].trim()) return r[k];
  }
  return null;
}

function orderNumberOf(r) {
  for (const k of ["order_number", "orderNumber", "number", "name", "id"]) {
    if (r[k] != null) return String(r[k]);
  }
  return null;
}

const LIST_KEYS = ["products", "data", "items", "results", "orders", "zones", "delivery_zones", "payment_methods", "methods", "categories", "banners", "list"];

function extractList(body, depth = 0) {
  if (Array.isArray(body)) return body;
  if (!isObj(body) || depth > 2) return null;
  for (const k of LIST_KEYS) if (Array.isArray(body[k])) return body[k];
  for (const k of Object.keys(body)) if (Array.isArray(body[k])) return body[k];
  for (const k of Object.keys(body)) {
    if (isObj(body[k])) {
      const inner = extractList(body[k], depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

function unwrapOne(body) {
  if (!isObj(body)) return body;
  for (const k of ["product", "order", "brand", "data", "item", "result"]) if (isObj(body[k])) return body[k];
  const keys = Object.keys(body);
  if (keys.length === 1 && isObj(body[keys[0]])) return body[keys[0]];
  return body;
}

module.exports = {
  FIELDS, RESOURCES, isObj, norm, leaves, getPath, propose, sampleFor, currentRows, isSaved,
  normaliseRows, saveVersion, rollback, fieldOptions, toProduct, toVariant, toOrder, toMoney, toNumber,
  sourcePathOf, idOf, titleOf, orderNumberOf, extractList, unwrapOne, zonesOf, currentExtras, CANON_STATUS, readRow, redact,
};
