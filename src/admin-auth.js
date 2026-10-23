"use strict";
const crypto = require("node:crypto");
const COOKIE = "chattrn_admin";
const TTL = 60 * 60;

function equal(a, b) {
  const left = crypto.createHash("sha256").update(String(a || "")).digest();
  const right = crypto.createHash("sha256").update(String(b || "")).digest();
  return crypto.timingSafeEqual(left, right);
}

function createAdminAuth(token, secure = false) {
  const signature = value => crypto.createHmac("sha256", token).update("dashboard-session:" + value).digest("base64url");
  const validSession = req => {
    const cookie = (req.headers.cookie || "").split(";").map(x => x.trim()).find(x => x.startsWith(COOKIE + "="));
    if (!cookie) return false;
    const [payload, sig] = cookie.slice(COOKIE.length + 1).split(".");
    if (!payload || !sig || !equal(signature(payload), sig)) return false;
    try {
      const session = JSON.parse(Buffer.from(payload, "base64url").toString());
      return Number.isFinite(session.expires) && session.expires > Date.now();
    } catch { return false; }
  };
  return {
    configured: !!token,
    headerValid: req => !!token && equal(req.headers["x-admin-token"], token),
    sessionValid: req => !!token && validSession(req),
    passwordValid: value => !!token && typeof value === "string" && equal(value, token),
    sameOrigin: req => {
      if (!req.headers.origin) return true;
      try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
    },
    issue: () => {
      const payload = Buffer.from(JSON.stringify({ expires: Date.now() + TTL * 1000, nonce: crypto.randomBytes(16).toString("hex") })).toString("base64url");
      return `${COOKIE}=${payload}.${signature(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL}${secure ? "; Secure" : ""}`;
    },
    clear: () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`,
  };
}
module.exports = { createAdminAuth };
