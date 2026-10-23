"use strict";
const { HttpError } = require("./http");

// Stable fixture identities until the host application's brand directory is integrated.
const DEFAULT_BRANDS = Object.freeze(["Brand A", "Brand B", "Brand C", "Brand D", "Brand E"]);
const brandKey = value => typeof value === "string" ? value.trim().toLowerCase() : "";

function assertBrandAvailable(stores, store, { required = false } = {}) {
  const key = brandKey(store.brand);
  if (!key) {
    if (required) throw new HttpError(422, "brand_required", "Assign a brand before connecting this store.");
    return;
  }
  const occupied = stores.find(other => other.id !== store.id && other.status === "connected" && brandKey(other.brand) === key);
  if (occupied) throw new HttpError(409, "brand_in_use", "This brand already has a connected store. Disconnect that store before connecting another.");
}

function brandDirectory(stores) {
  const brands = new Map(DEFAULT_BRANDS.map(name => [brandKey(name), { id: name, name }]));
  for (const store of stores) {
    const key = brandKey(store.brand);
    if (!key) continue;
    if (!brands.has(key)) brands.set(key, { id: store.brand.trim(), name: store.brand.trim() });
    if (store.status === "connected") {
      const brand = brands.get(key);
      brand.connected_store_id = store.id;
      brand.connected_store_name = store.name;
    }
  }
  return [...brands.values()];
}

module.exports = { DEFAULT_BRANDS, brandKey, assertBrandAvailable, brandDirectory };
