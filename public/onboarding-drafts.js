(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChattrnDrafts = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  var KINDS = ["mapped_api", "chattrn_api", "laravel_package"];
  var FIELDS = {
    mapped_api: ["storeName", "siteUrl", "base", "brand", "storeType", "auth", "header", "ctxName", "ctxValue"],
    chattrn_api: ["cStoreName", "cSiteUrl", "cBase", "cBrand", "cStoreType", "cRemember"],
    laravel_package: ["lStoreName", "lSiteUrl", "lBrand", "lStoreType"],
  };
  var TTL = 30 * 86400000;
  function object(v) { return v && typeof v === "object" && !Array.isArray(v); }
  function text(v, max) { return typeof v === "string" ? v.slice(0, max || 300) : ""; }
  function safeUrl(v) {
    if (!v) return "";
    try { var u = new URL(v); if (!/^https?:$/.test(u.protocol) || u.username || u.password) return ""; u.search = ""; u.hash = ""; return u.href; }
    catch (_) { return ""; }
  }
  function sanitize(input) {
    if (!object(input) || !KINDS.includes(input.kind)) throw new Error("Invalid draft type.");
    var d = { version: 1, kind: input.kind, store_id: /^[a-f0-9-]{36}$/.test(input.store_id || "") ? input.store_id : null,
      edited_at: Number.isFinite(Date.parse(input.edited_at)) && Date.parse(input.edited_at) <= Date.now() + 300000 ? new Date(input.edited_at).toISOString() : null,
      step: Math.max(1, Math.min(4, Math.trunc(Number(input.step)) || 1)), fields: {}, mappings: {}, laravel_values: {}, endpoints: [] };
    FIELDS[d.kind].forEach(function (key) {
      var v = input.fields && input.fields[key];
      if (typeof v !== "string" && typeof v !== "boolean") return;
      d.fields[key] = /^(siteUrl|base|cSiteUrl|cBase|lSiteUrl)$/.test(key) ? safeUrl(v) : typeof v === "boolean" ? v : text(v);
    });
    ["product", "variant", "zone"].forEach(function (scope) {
      d.mappings[scope] = {};
      Object.entries(object(input.mappings?.[scope]) ? input.mappings[scope] : {}).slice(0, 100).forEach(function ([key, v]) {
        if (/^[a-zA-Z0-9_]+$/.test(key) && !["__proto__", "constructor", "prototype"].includes(key) && object(v)) d.mappings[scope][key] = { primary: text(v.primary), fallback: text(v.fallback) };
      });
    });
    Object.entries(object(input.laravel_values) ? input.laravel_values : {}).slice(0, 150).forEach(function ([key, v]) {
      if (/^(models|columns|inventory|store)\.[a-zA-Z0-9_.]+$/.test(key) && !/(token|secret|password|__proto__|constructor|prototype)/i.test(key) && (v === null || typeof v === "string")) d.laravel_values[key] = v === null ? null : text(v, 500);
    });
    (Array.isArray(input.endpoints) ? input.endpoints : []).slice(0, 30).forEach(function (v) {
      // Save endpoint templates, not real customer phone numbers or query credentials.
      if (object(v) && /^[a-z_]+$/.test(v.id || "") && typeof v.path === "string" && /^\/(?!\/)/.test(v.path) && !/[#]|(?:token|secret|password|api[_-]?key)=/i.test(v.path) && !/[?&][^=]+=(?!:[a-z_]+(?:&|$)|\d{1,3}(?:&|$))[^&]+/i.test(v.path)) d.endpoints.push({ id: v.id, path: text(v.path, 500) });
    });
    return d;
  }
  function save(storage, input, now) {
    var d = sanitize(input); d.saved_at = new Date(now || Date.now()).toISOString(); d.edited_at = d.saved_at;
    storage.setItem("chattrn.draft.v1." + d.kind, JSON.stringify(d)); return d;
  }
  function load(storage, kind, now) {
    try { var raw = JSON.parse(storage.getItem("chattrn.draft.v1." + kind));
      if (!raw || !Number.isFinite(Date.parse(raw.saved_at)) || Date.parse(raw.saved_at) > (now || Date.now()) + 300000 || (now || Date.now()) - Date.parse(raw.saved_at) > TTL) return null;
      return Object.assign(sanitize(raw), { saved_at: raw.saved_at });
    } catch (_) { return null; }
  }
  return { KINDS: KINDS, FIELDS: FIELDS, TTL: TTL, sanitize: sanitize, save: save, load: load };
});
