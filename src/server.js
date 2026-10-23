"use strict";
// HTTP API for the "Connect a custom website" flow (Map my existing API, slice 2).
// Routes: stores, sign-in, endpoints, field mapping, zones, delivery settings, test runs, products.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { HttpError, assertPublicUrl } = require("./http");
const { Db, publicView } = require("./db");
const { loadSecretKey, encrypt, decrypt } = require("./crypto");
const CL = require("./chattrn-client");
const E = require("./endpoints");
const M = require("./mapping");
const { runTests } = require("./test-runner");
const { discoverZoneParam } = require("./location");
const { syncCatalog, catalogFor } = require("./catalog");
const CC = require("./chattrn-connector");
const { runChattrnTests } = require("./chattrn-test-runner");
const { sniffFramework } = require("./framework-sniff");
const LT = require("./laravel-token");

const AUTH_MODES = ["none", "key", "bearer", "basic"];
const DELIVERY_MODES = ["zone", "outlet"];
const ASK_WHEN = ["always", "when_needed", "never"];
const CONNECTION_TYPES = ["mapped_api", "chattrn_api", "laravel_package"];
const CHATTRN_LIKE = ["chattrn_api", "laravel_package"]; // both read through the native Chattrn connector

function createApp({ dataDir, publicDir, adminToken, secretKey }) {
  const db = new Db(path.join(dataDir, "stores.json"));
  const ctx = { db, secretKey: secretKey || loadSecretKey(dataDir) };
  const routes = [];

  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    routes.push({ method, re, keys, handler });
  };

  const findStore = (id) => {
    const s = db.find(id);
    if (!s) throw new HttpError(404, "store_not_found", "No store with that id.");
    return s;
  };

  const cleanBase = (raw) => {
    if (typeof raw !== "string" || !raw.trim()) throw new HttpError(400, "base_url_required", "Enter the base URL of the store's API.");
    let s = raw.trim().replace(/\/+$/, "").replace(/\/store\.json$/, "");
    if (/[?#]/.test(s)) throw new HttpError(400, "base_url_query", "Remove the ? or # part from the base URL.");
    if (!/^https?:\/\//.test(s)) throw new HttpError(400, "base_url_scheme", "The base URL must start with https://.");
    return s;
  };

  const validateAuth = (input, prev) => {
    const mode = input.mode || prev?.mode || "none";
    if (!AUTH_MODES.includes(mode)) throw new HttpError(400, "auth_mode", "Sign-in method must be none, key, bearer or basic.");
    const header = mode === "key" ? String(input.header || prev?.header || "X-API-Key").trim() : null;
    if (header !== null && !/^[A-Za-z0-9-]{1,64}$/.test(header)) throw new HttpError(400, "auth_header", "The header name can use letters, digits and dashes only.");
    const key = typeof input.key === "string" ? input.key.trim() : null;
    if (mode !== "none" && key !== null && (key.length < 1 || key.length > 512)) {
      throw new HttpError(400, "key_length", "The key must be between 1 and 512 characters.");
    }
    return { mode, header, key };
  };

  // ---- stores ----

  route("GET", "/api/health", () => ({ body: { ok: true, version: "0.1.0" } }));

  route("GET", "/api/stores", () => ({ body: { stores: db.list() } }));

  const cleanChattrnBase = (raw) => {
    if (typeof raw !== "string" || !raw.trim()) throw new HttpError(400, "base_url_required", "Enter the base URL of your Chattrn API.");
    let s = raw.trim().replace(/\/+$/, "").replace(/\/store\.json$/, "");
    if (/[?#]/.test(s)) throw new HttpError(400, "base_url_query", "Remove the ? or # part from the base URL.");
    if (!/^https?:\/\//.test(s)) throw new HttpError(400, "base_url_scheme", "The base URL must start with https://.");
    return s;
  };

  route("POST", "/api/stores", async ({ body }) => {
    const name = String(body.name || "").trim();
    if (!name || name.length > 120) throw new HttpError(400, "name_required", "Enter the store name (up to 120 characters).");
    const connection_type = CONNECTION_TYPES.includes(body.connection_type) ? body.connection_type : "mapped_api";
    const mode = body.delivery_mode;
    if (!DELIVERY_MODES.includes(mode)) throw new HttpError(422, "delivery_mode_required", "Choose the Store Type: zone or outlet.");
    const shared = {
      id: randomUUID(),
      name,
      website_url: body.website_url ? String(body.website_url).trim() : null,
      brand: body.brand ? String(body.brand).trim().slice(0, 120) || null : null,
      connection_type,
      status: "draft",
      delivery: { mode, context_param: null, param_confirmed: false, zone_value: null, ask_area_when: "when_needed", remember_area: false },
      samples: {},
      test_runs: [],
      created_at: new Date().toISOString(),
    };

    if (connection_type === "chattrn_api") {
      const base = cleanChattrnBase(body.base_url);
      await assertPublicUrl(base);
      const token = typeof body.access_token === "string" ? body.access_token.trim() : "";
      if (token && (token.length < 1 || token.length > 512)) throw new HttpError(400, "token_length", "The access token must be between 1 and 512 characters.");
      const store = {
        ...shared,
        currency: null,
        country_code: null,
        chattrn: {
          base_url: base,
          access_token_enc: token ? encrypt(token, ctx.secretKey) : null,
          api_version: null,
          capabilities: null,
        },
      };
      db.put(store);
      return { status: 201, body: publicView(store) };
    }

    if (connection_type === "laravel_package") {
      // Nothing to probe yet: the package isn't installed until the merchant runs the commands
      // on Install package and the package calls POST /package/register. Once it does, this
      // store gets the same chattrn.base_url / access_token_enc a native Chattrn API store has.
      const store = {
        ...shared,
        currency: null,
        country_code: null,
        chattrn: { base_url: null, access_token_enc: null, api_version: null, capabilities: null },
        laravel: {
          connection_token_hash: null, token_created_at: null, token_expires_at: null, token_used_at: null,
          package_version: null, framework_version: null, route_prefix: null, models_matched: null,
          registered_at: null, last_seen_at: null,
        },
      };
      db.put(store);
      return { status: 201, body: publicView(store) };
    }

    const base = cleanBase(body.base_url);
    await assertPublicUrl(base);
    const a = validateAuth(body.auth || {}, null);
    if (a.mode !== "none" && !a.key) throw new HttpError(400, "key_required", "Enter the key, or choose No sign-in.");
    const currency = body.currency ? String(body.currency).toUpperCase() : null;
    if (currency && !/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, "currency", "Currency must be a 3-letter ISO 4217 code, like BDT or USD.");
    const store = {
      ...shared,
      base_url: base,
      auth: { mode: a.mode, header: a.header, secret_enc: a.key ? encrypt(a.key, ctx.secretKey) : null },
      currency,
      country_code: body.country_code ? String(body.country_code).toUpperCase() : null,
      // The parameter name is unknown until discovery finds it (POST /location/discover).
      endpoints: {
        products: { method: "GET", path: "/products?page=:page", added: true },
        detail: { method: "GET", path: "/products/:id", added: true },
      },
      mapping: {},
    };
    db.put(store);
    return { status: 201, body: publicView(store) };
  });

  route("GET", "/api/stores/:id", ({ params }) => ({ body: publicView(findStore(params.id)) }));

  // Replace key: the new key is tested first. If it fails, the old key keeps working.
  route("PUT", "/api/stores/:id/auth", async ({ params, body }) => {
    const s = findStore(params.id);
    const a = validateAuth(body, s.auth);
    let secret_enc = s.auth.secret_enc;
    if (a.mode === "none") secret_enc = null;
    else if (a.key) {
      const probe = { ...s, auth: { mode: a.mode, header: a.header, secret_enc: encrypt(a.key, ctx.secretKey) } };
      const r = await E.getJudged(ctx, probe, "products", { page: "1" }, null);
      if (r.bad) throw new HttpError(422, "key_rejected", `The key wasn't saved. Your old key still works. ${r.bad.message}`);
      secret_enc = probe.auth.secret_enc;
    } else if (a.mode !== s.auth.mode) {
      throw new HttpError(400, "key_required", "Enter the key for this sign-in method.");
    }
    s.auth = { mode: a.mode, header: a.header, secret_enc };
    db.put(s);
    return { body: publicView(s) };
  });

  // Disconnect keeps the store and its saved sign-in, but it leaves the connected list.
  route("POST", "/api/stores/:id/disconnect", ({ params }) => {
    const s = findStore(params.id);
    s.status = "disconnected";
    db.put(s);
    return { body: publicView(s) };
  });

  route("POST", "/api/stores/:id/connection/check", async ({ params }) => {
    const s = findStore(params.id);
    const r = await E.getJudged(ctx, s, "products", { page: "1" }, null);
    if (r.bad) {
      return { body: { state: "error", http_status: r.bad.http, message: r.bad.message, duration_ms: r.res.ms } };
    }
    s.status = "connected";
    db.put(s);
    return { body: { state: "connected", http_status: r.res.http, message: "Connected. The product list responded.", duration_ms: r.res.ms } };
  });

  // ---- Chattrn API connection (native connector, slice 1B) ----

  const chattrnStore = (id) => {
    const s = findStore(id);
    if (!CHATTRN_LIKE.includes(s.connection_type)) throw new HttpError(409, "wrong_connection_type", "This store isn't connected through the Chattrn API.");
    return s;
  };

  // Validates store.json and that products.json reads too (devspec.txt: "API connection check").
  route("POST", "/api/stores/:id/chattrn/check", async ({ params }) => {
    const s = chattrnStore(params.id);
    const result = await CC.checkStore(ctx, s, { websiteUrl: s.website_url });
    if (result.state === "connected" && result.store) {
      s.currency = result.store.currency;
      s.country_code = result.store.country_code;
      s.delivery.mode = DELIVERY_MODES.includes(result.store.delivery_mode) ? result.store.delivery_mode : s.delivery.mode;
      s.chattrn.api_version = result.store.api_version;
      s.chattrn.capabilities = result.store.capabilities || {};
      s.status = "connected";
      db.put(s);
    }
    return { body: result };
  });

  // Replace key: the new token is tried first. If it fails, the old token keeps working.
  route("PUT", "/api/stores/:id/chattrn/token", async ({ params, body }) => {
    const s = chattrnStore(params.id);
    const token = typeof body.access_token === "string" ? body.access_token.trim() : "";
    if (!token || token.length > 512) throw new HttpError(400, "token_required", "Enter the new access token (up to 512 characters).");
    const result = await CC.checkStore(ctx, s, { websiteUrl: s.website_url, tokenOverride: token });
    if (result.state !== "connected") throw new HttpError(422, "token_rejected", `The token wasn't saved. Your old token still works. ${result.message}`);
    s.chattrn.access_token_enc = encrypt(token, ctx.secretKey);
    db.put(s);
    return { body: publicView(s) };
  });

  // The Connection tab's per-endpoint status list: the checks from the latest test run, if any.
  route("GET", "/api/stores/:id/chattrn/endpoints", ({ params }) => {
    const s = chattrnStore(params.id);
    const run = (s.test_runs || [])[0];
    return { body: { checked_at: run ? run.finished_at : null, checks: run ? run.checks : [] } };
  });

  // ---- Laravel package installer (slice 3; reads through the same native Chattrn connector) ----

  const laravelStore = (id) => {
    const s = findStore(id);
    if (s.connection_type !== "laravel_package") throw new HttpError(409, "wrong_connection_type", "This store isn't set up for the Laravel package.");
    return s;
  };

  // One request, not the full website-check service: just enough to power "Modal: Laravel not detected".
  route("POST", "/api/website-sniff", async ({ body }) => {
    const url = typeof body.website_url === "string" ? body.website_url.trim() : "";
    if (!url) throw new HttpError(400, "website_url_required", "Enter the website address first.");
    await assertPublicUrl(url);
    const result = await sniffFramework(url);
    return { body: result };
  });

  // Mints a fresh one-time CHATTRN_TOKEN for the install commands. Each call replaces any
  // still-pending token, so only the most recently shown value will register.
  route("POST", "/api/stores/:id/laravel/connection-token", ({ params }) => {
    const s = laravelStore(params.id);
    const issued = LT.issueConnectionToken(s);
    db.put(s);
    return { body: issued };
  });

  // The package's own endpoint (devspec.txt: "The package's register endpoint: POST /package/register").
  // On first boot the package sends the token, site URL, route prefix and versions; Chattrn
  // returns the access key it will send as X-Chattrn-Access-Token from then on.
  route("POST", "/package/register", async ({ body }) => {
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) throw new HttpError(400, "token_required", "Missing connection token.");
    const s = db.findByLaravelTokenHash(LT.hashToken(token));
    if (!s) throw new HttpError(401, "token_invalid", "Token rejected.");
    const check = LT.verifyConnectionToken(s, token);
    if (!check.ok) throw new HttpError(check.reason === "token_expired" ? 410 : 401, check.reason, check.message);

    const siteUrl = typeof body.site_url === "string" ? body.site_url.trim().replace(/\/+$/, "") : "";
    const routePrefix = typeof body.route_prefix === "string" && body.route_prefix.trim() ? body.route_prefix.trim().replace(/^\/?/, "/").replace(/\/+$/, "") : "/chattrn/v1";
    if (!siteUrl) throw new HttpError(400, "site_url_required", "Missing site_url.");
    await assertPublicUrl(siteUrl);

    const accessKey = LT.newToken();
    const now = new Date().toISOString();
    s.laravel.token_used_at = now;
    s.laravel.package_version = body.package_version ? String(body.package_version).slice(0, 40) : s.laravel.package_version;
    s.laravel.framework_version = body.framework_version ? String(body.framework_version).slice(0, 40) : s.laravel.framework_version;
    s.laravel.route_prefix = routePrefix;
    if (body.models_matched && typeof body.models_matched === "object") {
      s.laravel.models_matched = {
        product: !!body.models_matched.product, variant: !!body.models_matched.variant,
        order: !!body.models_matched.order, customer: !!body.models_matched.customer,
      };
    }
    s.laravel.registered_at = s.laravel.registered_at || now;
    s.laravel.last_seen_at = now;
    s.chattrn.base_url = siteUrl + routePrefix;
    s.chattrn.access_token_enc = encrypt(accessKey, ctx.secretKey);
    db.put(s);
    return { body: { access_token: accessKey, store_id: s.id } };
  });

  // Rotates the access key the package uses. Spec: "Regenerating the token revokes the old
  // access key" - immediate, not gated behind a live check since the package hasn't seen the
  // new value yet. The new key is shown once; after that only its last 4 characters are kept.
  route("POST", "/api/stores/:id/laravel/regenerate-token", ({ params }) => {
    const s = laravelStore(params.id);
    if (!s.laravel.registered_at) throw new HttpError(409, "not_registered", "The package hasn't registered yet, so there's no token to regenerate.");
    const accessKey = LT.newToken();
    s.chattrn.access_token_enc = encrypt(accessKey, ctx.secretKey);
    db.put(s);
    return { body: { access_token: accessKey } };
  });

  // Install status (devspec.txt): Package installed, Store linked with your token, Chattrn API
  // reachable, Tables matched, First product sync. Polled by the wizard's "Waiting for your
  // store to finish connecting" card and mirrored on the Connection (Laravel package) tab.
  // Install status, Figma "Environment" card on Connect (step 1). Scoped to the token
  // handshake only: whether tables are mapped is step 2's job and whether the API answers is
  // step 3's, so neither is reported here - showing a mapping verdict before mapping has run
  // is what the redesign set out to fix.
  route("GET", "/api/stores/:id/laravel/install-status", async ({ params }) => {
    const s = laravelStore(params.id);
    const l = s.laravel;
    const used = !!l.token_used_at;
    const registered = !!l.registered_at && !!s.chattrn.access_token_enc;
    const checks = [
      {
        key: "token_in_env", label: "CHATTRN_TOKEN present in environment",
        state: used ? "pass" : "pending",
        message: used ? "Found in your host's environment variables" : "Paste the token into your host's environment, then redeploy.",
      },
      {
        key: "config_resolves", label: "Laravel config sees it",
        state: used ? "pass" : "pending",
        message: used ? "config('chattrn.connection_token') resolves" : "Waiting for the package to read it. A stale config:cache is the usual cause.",
      },
      {
        key: "access_token_issued", label: "Access token issued",
        state: registered ? "pass" : "pending",
        message: registered ? "CHATTRN_ACCESS_TOKEN stored \u2014 registration complete" : "Run php artisan chattrn:register once the token is in place.",
      },
    ];
    let masked = null;
    if (registered) {
      try {
        const plain = decrypt(s.chattrn.access_token_enc, ctx.secretKey);
        masked = plain ? plain.slice(0, 8) + "\u2022".repeat(12) + plain.slice(-16) : null;
      } catch { masked = null; }
    }
    return {
      body: {
        checks,
        registered,
        package_version: l.package_version || null,
        access_token_masked: masked,
        can_continue: registered,
      },
    };
  });

  // ---- Laravel table mapping (step 2) ----
  // The package introspects the merchant's own Eloquent models and columns; Chattrn never
  // guesses a schema it cannot see. These two proxy that introspection through the access
  // token already held for this store, the same transport as every other package call.
  route("GET", "/api/stores/:id/laravel/tables", async ({ params }) => {
    const s = laravelStore(params.id);
    if (!s.laravel.registered_at || !s.chattrn.base_url) throw new HttpError(409, "not_registered", "The package hasn't registered yet.");
    const res = await CL.call(ctx, s, { path: "/mapping.json" });
    if (res.status !== 200 || !res.json) throw new HttpError(502, "package_unreachable", `The package did not return a mapping (HTTP ${res.status}).`);
    return { body: res.json };
  });

  route("PUT", "/api/stores/:id/laravel/mapping", async ({ params, body }) => {
    const s = laravelStore(params.id);
    if (!s.laravel.registered_at || !s.chattrn.base_url) throw new HttpError(409, "not_registered", "The package hasn't registered yet.");
    const res = await CL.call(ctx, s, { path: "/mapping.json", method: "PUT", body: { values: (body && body.values) || {} } });
    if (res.status !== 200 || !res.json) throw new HttpError(502, "package_unreachable", `The package did not save the mapping (HTTP ${res.status}).`);
    s.laravel.last_seen_at = new Date().toISOString();
    db.put(s);
    return { body: res.json };
  });

  // ---- endpoints ----

  route("GET", "/api/stores/:id/endpoints", ({ params }) => ({ body: { endpoints: E.listEndpoints(findStore(params.id)) } }));

  route("PUT", "/api/stores/:id/endpoints/:key", ({ params, body }) => {
    const s = findStore(params.id);
    const d = E.def(params.key);
    if (!d) throw new HttpError(404, "unknown_endpoint", "Unknown endpoint.");
    const method = String(body.method || d.method).toUpperCase();
    const allowed = d.write ? ["POST", "PUT", "DELETE"] : ["GET"];
    if (!allowed.includes(method)) throw new HttpError(422, "method", `${d.name} uses ${allowed.join(" or ")}.`);
    const p = String(body.path || d.path);
    if (!p.startsWith("/") || p.includes("://") || p.length > 300) throw new HttpError(422, "path", "The path must start with / and be a path on the store, not a full address.");
    s.endpoints = s.endpoints || {};
    s.endpoints[params.key] = { ...(s.endpoints[params.key] || {}), method, path: p, added: true };
    db.put(s);
    return { body: E.configOf(s, params.key) };
  });

  route("POST", "/api/stores/:id/endpoints/:key/check", async ({ params, body }) => {
    const s = findStore(params.id);
    const zone = body.zone != null && body.zone !== "" ? { name: s.delivery.context_param, value: String(body.zone) } : null;
    const result = await E.checkEndpoint(ctx, s, params.key, {
      id: body.id, query: body.query, phone: body.phone, number: body.number, context: zone,
    });
    db.put(s);
    return { body: result };
  });

  // ---- mapping ----

  const resourceOf = (q) => {
    const r = q.resource || "product";
    if (!M.RESOURCES.includes(r)) throw new HttpError(400, "resource", `Resource must be one of ${M.RESOURCES.join(", ")}.`);
    return r;
  };

  route("POST", "/api/stores/:id/mapping/propose", ({ params, body }) => {
    const s = findStore(params.id);
    const resource = resourceOf(body);
    const sample = M.sampleFor(s, resource);
    if (!sample) throw new HttpError(409, "no_sample", "Check Product list first, so there is a sample to match against.");
    const proposal = M.propose(resource, sample);
    return { body: { ...proposal, saved: M.isSaved(s, resource) } };
  });

  route("GET", "/api/stores/:id/mapping", ({ params, query }) => {
    const s = findStore(params.id);
    const resource = resourceOf(query);
    const m = s.mapping?.[resource];
    return {
      body: {
        resource,
        saved: M.isSaved(s, resource),
        current_version: m?.current || null,
        versions: (m?.versions || []).map((v) => ({ version: v.version, saved_at: v.saved_at, rows: v.rows.length })),
        rows: M.currentRows(s, resource),
        extras: resource === "product" ? M.currentExtras(s, "product") : [],
        // The customer tab: phone and name are used to find orders and are never copied.
        never_copied: resource === "customer",
      },
    };
  });

  route("PUT", "/api/stores/:id/mapping", ({ params, body }) => {
    const s = findStore(params.id);
    const resource = resourceOf(body);
    const { rows, extras } = M.normaliseRows(s, resource, body.rows, body.extras);
    const version = M.saveVersion(s, resource, rows, extras);
    db.put(s);
    return { body: { resource, version, rows, extras } };
  });

  route("POST", "/api/stores/:id/mapping/rollback", ({ params, body }) => {
    const s = findStore(params.id);
    const resource = resourceOf(body);
    const version = M.rollback(s, resource);
    db.put(s);
    return { body: { resource, version } };
  });

  route("GET", "/api/stores/:id/fields", ({ params, query }) => {
    const s = findStore(params.id);
    const resource = resourceOf(query);
    return { body: { resource, fields: M.fieldOptions(s, resource, query.compatible_with) } };
  });

  // ---- zones and delivery ----

  route("GET", "/api/stores/:id/zones", async ({ params }) => {
    const s = findStore(params.id);
    if (CHATTRN_LIKE.includes(s.connection_type)) {
      const r = await CC.listLocations(ctx, s);
      if (r.res.error || r.res.http !== 200) throw new HttpError(502, "store_error", "Could not read locations from the store.");
      const zones = r.list.map((l) => ({
        id: l.id, name: l.name,
        areas: l.x_chattrn && Array.isArray(l.x_chattrn.areas) ? l.x_chattrn.areas : [],
        min_order: l.x_chattrn ? l.x_chattrn.min_order : null,
      }));
      s.samples = { ...(s.samples || {}), zone: r.list.slice(0, 5) };
      db.put(s);
      return { body: { zones, count: zones.length, mapped: true, context_param: null, chosen: s.delivery.zone_value ?? null } };
    }
    const r = await E.getJudged(ctx, s, "zones", {}, null);
    if (r.bad) throw new HttpError(502, "store_error", r.bad.message);
    const list = (M.extractList(r.body) || []).filter(M.isObj);
    s.samples = { ...(s.samples || {}), zone: list.slice(0, 5) };
    db.put(s);
    const zones = M.zonesOf(s, list);
    return {
      body: {
        zones,
        count: zones.length,
        mapped: M.isSaved(s, "zone"),
        context_param: s.delivery.context_param,
        chosen: s.delivery.zone_value ?? null,
      },
    };
  });

  route("PUT", "/api/stores/:id/delivery-settings", ({ params, body }) => {
    const s = findStore(params.id);
    const mode = body.mode || s.delivery.mode;
    if (!DELIVERY_MODES.includes(mode)) throw new HttpError(422, "delivery_mode", "Mode must be zone or outlet.");
    const ask = body.ask_area_when || s.delivery.ask_area_when;
    if (!ASK_WHEN.includes(ask)) throw new HttpError(422, "ask_area_when", `ask_area_when must be ${ASK_WHEN.join(", ")}.`);
    // zone: the zone or outlet id every product call is sent with. Empty clears it.
    const zone_value = body.zone === undefined ? s.delivery.zone_value ?? null : body.zone === null || body.zone === "" ? null : String(body.zone);
    // A parameter name the probe confirmed for this store is kept while the mode stays the same.
    const prev = s.delivery || {};
    const keep = prev.param_confirmed && prev.mode === mode;
    s.delivery = {
      mode,
      context_param: keep ? prev.context_param : null,
      param_confirmed: !!keep,
      location_probe: keep ? prev.location_probe : undefined,
      zone_value,
      ask_area_when: ask,
      remember_area: body.remember_area === undefined ? s.delivery.remember_area : !!body.remember_area,
    };
    db.put(s);
    return { body: s.delivery };
  });

  // ---- test runs and products ----

  route("POST", "/api/stores/:id/catalog/sync", async ({ params }) => {
    const s = findStore(params.id);
    const result = await syncCatalog(ctx, s, { deadline: Date.now() + 55000 });
    if (result.ok) db.put(s);
    return { body: result };
  });

  // Products a customer in one zone can be offered (from the last sync). Without ?zone, every synced product.
  route("GET", "/api/stores/:id/catalog", ({ params, query }) => {
    const s = findStore(params.id);
    if (!s.catalog) throw new HttpError(409, "not_synced", "Sync the catalog first: POST /api/stores/:id/catalog/sync.");
    const zone = query.zone != null && query.zone !== "" ? String(query.zone) : null;
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
    const items = catalogFor(s, zone);
    return { body: { zone, count: items.length, synced_at: s.catalog.synced_at, products: items.slice(0, limit) } };
  });

  route("POST", "/api/stores/:id/location/discover", async ({ params }) => {
    const s = findStore(params.id);
    const result = await discoverZoneParam(ctx, s);
    db.put(s);
    return { body: { ...result, context_param: s.delivery.context_param, param_confirmed: !!s.delivery.param_confirmed } };
  });

  route("POST", "/api/stores/:id/test-runs", async ({ params, body }) => {
    const s = findStore(params.id);
    const run = CHATTRN_LIKE.includes(s.connection_type)
      ? await runChattrnTests(ctx, s, {})
      : await runTests(ctx, s, { phone: body.phone || null, zone: body.zone ?? null, rediscover: !!body.rediscover });
    db.put(s);
    return { body: run };
  });

  route("GET", "/api/stores/:id/test-runs/latest", ({ params }) => {
    const s = findStore(params.id);
    const run = (s.test_runs || [])[0];
    if (!run) throw new HttpError(404, "no_runs", "No test has been run for this store yet.");
    return { body: run };
  });

  // Orders for a test phone, in Chattrn's order model. Customer fields are not returned.
  route("GET", "/api/stores/:id/orders", async ({ params, query }) => {
    const s = findStore(params.id);
    if (!query.phone) throw new HttpError(400, "phone_required", "Enter a phone to look up orders. It isn't stored.");
    const r = await E.getJudged(ctx, s, "orders", { phone: query.phone }, null);
    if (r.bad) throw new HttpError(502, "store_error", r.bad.message);
    const list = (M.extractList(r.body) || []).filter(M.isObj);
    s.samples = { ...(s.samples || {}), orders: list.slice(0, 20).map(M.redact) };
    db.put(s);
    return { body: { count: list.length, orders: list.map((raw) => M.toOrder(s, raw)) } };
  });

  route("GET", "/api/stores/:id/products", async ({ params, query }) => {
    const s = findStore(params.id);
    const zone = query.zone != null && query.zone !== "" ? { name: s.delivery.context_param, value: String(query.zone) } : null;
    const useSearch = !!query.query && !!s.endpoints?.search;
    const host = new URL(s.base_url).host;
    const r = useSearch
      ? await E.getJudged(ctx, s, "search", { query: query.query }, zone, host)
      : await E.getJudged(ctx, s, "products", { page: String(query.page || 1) }, zone, host);
    if (r.bad) throw new HttpError(502, "store_error", r.bad.message);
    const list = (M.extractList(r.body) || []).filter(M.isObj);
    const products = list.map((raw) => M.toProduct(s, raw));
    return { body: { source: useSearch ? "search" : "list", page: Number(query.page || 1), count: products.length, products } };
  });

  // ---- static pages ----

  const serveFile = (res, file, type) => {
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found"); return; }
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(data);
    });
  };

  // ---- dispatcher ----

  const sendJson = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > 1024 * 1024) { reject(new HttpError(413, "too_large", "Request body is over 1 MB.")); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new HttpError(400, "bad_json", "The request body must be JSON.")); }
      });
      req.on("error", reject);
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/flow-tester")) {
        return serveFile(res, path.join(publicDir, "flow-tester.html"), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === "/openapi.yaml") {
        return serveFile(res, path.join(publicDir, "openapi.yaml"), "text/yaml; charset=utf-8");
      }
      // The Laravel package's own callback (devspec.txt) isn't under /api/ - it's called by the
      // merchant's server, not by our frontend, and never carries the admin token below.
      const isPackageCallback = req.method === "POST" && url.pathname === "/package/register";
      if (!url.pathname.startsWith("/api/") && !isPackageCallback) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("Not found");
      }
      if (adminToken && !isPackageCallback && req.headers["x-admin-token"] !== adminToken) {
        return sendJson(res, 401, { error: { code: "unauthorized", message: "Missing or wrong admin token." } });
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const query = Object.fromEntries(url.searchParams.entries());
        const body = ["POST", "PUT"].includes(req.method) ? await readBody(req) : {};
        const out = await r.handler({ params, query, body, ctx });
        return sendJson(res, out.status || 200, out.body);
      }
      return sendJson(res, 404, { error: { code: "not_found", message: "No such route." } });
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: { code: e.code, message: e.message } });
      console.error(e);
      return sendJson(res, 500, { error: { code: "internal", message: "Something went wrong on the server." } });
    }
  });

  return { server, ctx, db };
}

if (require.main === module) {
  const root = path.join(__dirname, "..");
  const port = Number(process.env.PORT || 3100);
  const { server } = createApp({
    dataDir: process.env.DATA_DIR || path.join(root, "data"),
    publicDir: path.join(root, "public"),
    adminToken: process.env.ADMIN_TOKEN || null,
  });
  server.listen(port, () => console.log(`Chattrn connector backend on http://localhost:${port}`));
}

module.exports = { createApp };
