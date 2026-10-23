"use strict";
// A single JSON file holds the stores. Writes go to a temp file, then rename, so a crash
// never leaves a half-written file. Good enough for one process; swap for Postgres later.
const fs = require("node:fs");
const path = require("node:path");

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
    return this.data.stores[id] || null;
  }

  // The Laravel package's register call only has the plaintext connection token, not a store id,
  // so it's looked up by the hash of the pending one-time token (src/laravel-token.js).
  findByLaravelTokenHash(hash) {
    return Object.values(this.data.stores).find((s) => s.laravel && s.laravel.connection_token_hash === hash) || null;
  }

  put(store) {
    store.updated_at = new Date().toISOString();
    this.data.stores[store.id] = store;
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
  const { auth, chattrn, laravel, onboarding_draft, ...rest } = store;
  const out = { ...rest };
  if (onboarding_draft) out.onboarding_draft_saved_at = onboarding_draft.saved_at;
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
