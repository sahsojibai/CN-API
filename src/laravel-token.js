"use strict";
// Token flow for the Laravel package installer (devspec.txt "Slice 3: Laravel package installer").
//
// Two different tokens, both formatted ct_live_<hex>, per the spec's naming:
//   - the one-time "connection token" (CHATTRN_TOKEN=...) the merchant pastes into .env. It's
//     single-use and expires if unused; only its hash is stored.
//   - the ongoing access key the register call returns, stored encrypted exactly like a native
//     Chattrn API store's access token (reuses store.chattrn.access_token_enc / the existing
//     /chattrn/check, /chattrn/token, /chattrn/endpoints routes - "no new connector is needed").
const crypto = require("node:crypto");

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes, unused

function newToken() {
  return "ct_live_" + crypto.randomBytes(24).toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Mints a fresh one-time connection token for a store, replacing any still-pending one.
function issueConnectionToken(store) {
  const token = newToken();
  const now = new Date();
  store.laravel = {
    ...(store.laravel || {}),
    connection_token_hash: hashToken(token),
    token_created_at: now.toISOString(),
    token_expires_at: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
    token_used_at: null,
  };
  return { token, expires_at: store.laravel.token_expires_at };
}

// Verifies a token presented to POST /package/register against one store's pending token.
// Never logs the token itself (devspec.txt: "the register call never logs the token").
function verifyConnectionToken(store, token) {
  const l = store.laravel;
  if (!l || !l.connection_token_hash) return { ok: false, reason: "no_token", message: "No connection token has been issued for this store." };
  if (l.token_used_at) return { ok: false, reason: "token_used", message: "This connection token was already used. Create a new one and try again." };
  if (!l.token_expires_at || new Date(l.token_expires_at) < new Date()) return { ok: false, reason: "token_expired", message: "This connection token expired. Create a new one." };
  if (hashToken(token) !== l.connection_token_hash) return { ok: false, reason: "token_mismatch", message: "Token rejected." };
  return { ok: true };
}

module.exports = { newToken, hashToken, issueConnectionToken, verifyConnectionToken, TOKEN_TTL_MS };
