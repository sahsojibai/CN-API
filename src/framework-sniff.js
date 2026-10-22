"use strict";
// A single-request framework sniff, just enough to power the "Laravel not detected" modal
// (devspec.txt: "0b and Modal: Laravel not detected"). This is deliberately NOT the full
// "Website check" service (devspec.txt's multi-endpoint recommendation engine with evidence
// rows, confidence, caching and rate limits) - that's a separate, larger piece and stays out
// of scope. This just fetches the homepage once and looks for a handful of signals.
const { request, assertPublicUrl } = require("./http");

const FRAMEWORK_MARKERS = [
  { name: "WordPress", test: (text) => /\/wp-content\/|\/wp-json\//i.test(text) },
  { name: "Shopify", test: (text) => /cdn\.shopify\.com/i.test(text) },
  { name: "Next.js", test: (text) => /\/_next\//i.test(text) },
  { name: "Nuxt", test: (text) => /\/_nuxt\//i.test(text) },
];

function looksLikeLaravel(cookies) {
  return cookies.some((c) => /laravel_session|XSRF-TOKEN/i.test(c));
}

// Returns { laravel_likely, framework } - framework is the best guess at what's running when
// Laravel signals are absent, or null when nothing recognisable was found.
async function sniffFramework(url) {
  await assertPublicUrl(url);
  const res = await request({ url, method: "GET", timeoutMs: 5000 });
  // A network failure means we never got headers or a body to look at. An HTTP error status
  // (404, 500, a login redirect...) still carries cookies and markup worth inspecting.
  if (res.error || res.http == null) {
    return { laravel_likely: null, framework: null, checked: false, message: res.message || "Could not reach that address." };
  }
  const cookies = res.setCookie || [];
  if (looksLikeLaravel(cookies)) {
    return { laravel_likely: true, framework: "Laravel", checked: true };
  }
  const text = res.text || "";
  const hit = FRAMEWORK_MARKERS.find((m) => m.test(text));
  return { laravel_likely: false, framework: hit ? hit.name : null, checked: true };
}

module.exports = { sniffFramework };
