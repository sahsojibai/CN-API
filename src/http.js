"use strict";
// Outbound HTTP for calls to a store's own API. Enforces the gateway's safety rules:
// HTTPS only, public IPs only, no redirects, a timeout, a 2 MB size cap and a
// minimum gap between calls to the same store (5 requests per second).
const dns = require("node:dns").promises;
const net = require("node:net");

const MAX_BYTES = 2 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ALLOW_PRIVATE_HOSTS=1 is for local tests only (mock store on 127.0.0.1, plain HTTP).
function allowPrivate() {
  return process.env.ALLOW_PRIVATE_HOSTS === "1";
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) {
      const tail = v.slice(7);
      return net.isIPv4(tail) ? isPrivateIp(tail) : true; // hex-mapped form: refuse
    }
    return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  return true;
}

async function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, "bad_url", "That address isn't a valid URL.");
  }
  const local = allowPrivate();
  if (!(u.protocol === "https:" || (local && u.protocol === "http:"))) {
    throw new HttpError(400, "not_https", "Use an HTTPS address.");
  }
  if (u.username || u.password) {
    throw new HttpError(400, "credentials_in_url", "Remove the username and password from the address.");
  }
  if (local) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addrs;
  if (net.isIP(host)) {
    addrs = [{ address: host }];
  } else {
    try {
      addrs = await dns.lookup(host, { all: true });
    } catch {
      throw new HttpError(502, "dns", `We couldn't reach ${host} (DNS lookup failed). Check the address.`);
    }
  }
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw new HttpError(400, "private_address", "That address points to a private network, so it's refused.");
  }
  return u;
}

// Returns a plain result object; never throws for network or HTTP problems.
async function request({ url, method = "GET", headers = {}, body, timeoutMs = 10000 }) {
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  let u;
  try {
    u = await assertPublicUrl(url);
  } catch (e) {
    return { http: null, ms: 0, error: "refused", message: e.message };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(u, { method, headers, body, redirect: "manual", signal: ctrl.signal });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      return { http: res.status, ms: elapsed(), error: "redirect", isJson: false, text: "" };
    }
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > MAX_BYTES) {
      await res.body?.cancel().catch(() => {});
      return { http: res.status, ms: elapsed(), error: "too_large", isJson: false, text: "" };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      return { http: res.status, ms: elapsed(), error: "too_large", isJson: false, text: "" };
    }
    const text = buf.toString("utf8");
    let json = null;
    let isJson = false;
    if (text.length) {
      try {
        json = JSON.parse(text);
        isJson = true;
      } catch {
        isJson = false;
      }
    }
    return {
      http: res.status,
      ms: elapsed(),
      json,
      isJson,
      empty: text.length === 0,
      text: text.slice(0, 2000),
      retryAfter: res.headers.get("retry-after"),
      link: res.headers.get("link"),
      setCookie: typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []),
    };
  } catch (e) {
    if (e.name === "AbortError") return { http: null, ms: elapsed(), error: "timeout" };
    return {
      http: null,
      ms: elapsed(),
      error: "network",
      reason: (e.cause && (e.cause.code || e.cause.message)) || e.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

const lastCallAt = new Map();

async function throttle(key, gapMs = 200) {
  const prev = lastCallAt.get(key) || 0;
  const wait = prev + gapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt.set(key, Date.now());
}

module.exports = { HttpError, request, throttle, assertPublicUrl, isPrivateIp, MAX_BYTES };
