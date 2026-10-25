"use strict";
// Every call to a store's own API goes through here: adds the sign-in header, the
// test header, the zone/outlet parameter, and applies the per-store throttle.
const { request, throttle } = require("./http");
const { decrypt } = require("./crypto");

function authHeaders(auth, key) {
  const h = { Accept: "application/json", "X-Chattrn-Test": "1" };
  if (!key || auth.mode === "none") return h;
  if (auth.mode === "key") h[auth.header || "X-API-Key"] = key;
  else if (auth.mode === "bearer") h.Authorization = `Bearer ${key}`;
  else if (auth.mode === "basic") h.Authorization = `Basic ${Buffer.from(key).toString("base64")}`;
  return h;
}

// opts: { path, context: {name, value}|null, method, timeoutMs, keyOverride, body }
async function call(ctx, store, opts) {
  const { path, context = null, method = "GET", timeoutMs = 10000, keyOverride, body } = opts;
  let url = store.base_url.replace(/\/+$/, "") + path;
  if (context && context.name && context.value != null && context.value !== "") {
    const scoped = new URL(url);
    // Pagination links cannot silently switch a location or add conflicting duplicate values.
    scoped.searchParams.set(context.name, String(context.value));
    url = scoped.toString();
  }
  await throttle(new URL(url).origin);
  let key = keyOverride;
  if (key === undefined) key = store.auth.secret_enc ? decrypt(store.auth.secret_enc, ctx.secretKey) : "";
  let payload;
  const headers = authHeaders(store.auth, key);
  if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  return request({ url, method, headers, body: payload, timeoutMs });
}

module.exports = { call, authHeaders };
