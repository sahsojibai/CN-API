"use strict";
// A single JSON file holds the stores. Writes go to a temp file, then rename, so a crash
// never leaves a half-written file. Good enough for one process; swap for Postgres later.
const fs = require("node:fs");
const path = require("node:path");
const { assertBrandAvailable } = require("./brands");
const { configurationStamp } = require("./onboarding");
const { HttpError } = require("./http");

class Db {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { stores: {} };
  }

  // Public view: never includes the encrypted key.
  list() {
    return Object.values(this.data.stores).map(publicView);
  }

  // Internal view (includes auth.secret_enc). Do not return this from an HTTP route.
  find(id) {
    return this.data.stores[id] ? structuredClone(this.data.stores[id]) : null;
  }

  // The Laravel package's register call only has the plaintext connection token, not a store id,
  // so it's looked up by the hash of the pending one-time token (src/laravel-token.js).
  findByLaravelTokenHash(hash) {
    const store = Object.values(this.data.stores).find((s) => s.laravel && s.laravel.connection_token_hash === hash);
    return store ? structuredClone(store) : null;
  }

  pendingCatalogJobs() {
    return Object.values(this.data.stores).filter(s => ["queued", "running"].includes(s.catalog_sync?.status) ||
      (!s.catalog_sync && s.status === "connected" && (s.base_url || s.chattrn?.base_url)) ||
      (s.status === "connected" && s.catalog_sync?.status === "complete" && Date.parse(s.catalog_sync.next_sync_at) <= Date.now())).map(s => s.id);
  }

  putCatalog(store) {
    const current = this.data.stores[store.id];
    if (!current || current.status !== store.status || current.catalog_sync?.id !== store.catalog_sync?.id || configurationStamp(current) !== configurationStamp(store)) {
      throw new HttpError(409, "store_changed", "Store changed during the catalog checkpoint.");
    }
    const next = structuredClone(current);
    for (const key of ["catalog", "catalog_build", "catalog_sync"]) {
      if (store[key] === undefined) delete next[key]; else next[key] = structuredClone(store[key]);
    }
    return this.put(next, { catalog: true });
  }

  put(store, { catalog = false } = {}) {
    const current = this.data.stores[store.id];
    if (!catalog && current) {
      for (const key of ["catalog", "catalog_build", "catalog_sync"]) {
        if (current[key] === undefined) delete store[key]; else store[key] = structuredClone(current[key]);
      }
    }
    if (store.status === "connected") assertBrandAvailable(Object.values(this.data.stores), store, { required: true });
    store.updated_at = new Date().toISOString();
    this.data.stores[store.id] = structuredClone(store);
    this.flush();
    return store;
  }

  flush() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

function publicView(store) {
  const { auth, chattrn, laravel, onboarding_draft, catalog_build, ...rest } = store;
  const out = { ...rest };
  if (store.catalog) out.catalog = { ...store.catalog, products_total: store.catalog.products_total ?? store.catalog.products.length, products: store.catalog.products.slice(0, 20) };
  if (store.catalog_sync) {
    const job = store.catalog_sync;
    out.catalog_sync = { id: job.id, status: job.status, phase: job.phase, locations_done: job.locations_done, error: job.error,
      products_total: job.products_total ?? (catalog_build || store.catalog)?.products?.length ?? 0, next_sync_at: job.next_sync_at, plan: job.plan && { locations: job.plan.locations } };
  }
  if (auth) out.auth = { mode: auth.mode, header: auth.header || null, key_saved: !!auth.secret_enc };
  if (chattrn) out.chattrn = { base_url: chattrn.base_url, api_version: chattrn.api_version || null, capabilities: chattrn.capabilities || null, token_saved: !!chattrn.access_token_enc };
  // Never expose the one-time connection-token hash, or whether one is pending, beyond what the
  // wizard needs to decide if it should mint a fresh one.
  if (laravel) {
    out.laravel = {
      package_version: laravel.package_version || null,
      framework_version: laravel.framework_version || null,
      route_prefix: laravel.route_prefix || null,
      models_matched: laravel.models_matched || null,
      registered_at: laravel.registered_at || null,
      last_seen_at: laravel.last_seen_at || null,
      token_pending: !!(laravel.connection_token_hash && !laravel.token_used_at && laravel.token_expires_at && laravel.token_expires_at > new Date().toISOString()),
    };
  }
  return out;
}

module.exports = { Db, publicView };
