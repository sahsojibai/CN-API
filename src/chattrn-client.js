"use strict";
// Every call to a store's native Chattrn API goes through here: adds the access-token header,
// the test header, and applies the per-store throttle. Mirrors store-client.js (mapped connector).
const { request, throttle } = require("./http");
const { decrypt } = require("./crypto");

function authHeaders(token) {
  const h = { Accept: "application/json", "X-Chattrn-Test": "1", "User-Agent": "Chattrn/1.0 (+https://chattrn.com/bot)" };
  if (token) h["X-Chattrn-Access-Token"] = token;
  return h;
}

// opts: { path, method, timeoutMs, tokenOverride, body }
async function call(ctx, store, opts) {
  const { path, method = "GET", timeoutMs = 10000, tokenOverride, body } = opts;
  const base = store.chattrn.base_url.replace(/\/+$/, "");
  const url = path.startsWith("http") ? path : base + path;
  // Never forward merchant credentials to a pagination URL on a different origin.
  if (new URL(url).origin !== new URL(base).origin) throw new Error("Pagination URL must stay on the API origin.");
  await throttle(store.id);
  let token = tokenOverride;
  if (token === undefined) token = store.chattrn.access_token_enc ? decrypt(store.chattrn.access_token_enc, ctx.secretKey) : "";
  const headers = authHeaders(token);
  let payload = body;
  if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  return request({ url, method, headers, body: payload, timeoutMs });
}

module.exports = { call, authHeaders };
