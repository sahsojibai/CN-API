"use strict";
const { request, assertPublicUrl } = require("./http");
const MARKERS = [
  ["WordPress", /\/wp-content\/|\/wp-json\//i], ["Shopify", /cdn\.shopify\.com/i],
  ["Next.js", /\/_next\//i], ["Nuxt", /\/_nuxt\//i],
];
async function sniffFramework(url, transport = request) {
  await assertPublicUrl(url);
  const discovery = new URL(url);
  discovery.pathname = discovery.pathname.replace(/\/+$/, "") + "/.well-known/chattrn.json";
  discovery.search = ""; discovery.hash = "";
  const probe = await transport({ url: discovery.href, method: "GET", timeoutMs: 5000 });
  const meta = probe.json;
  if (probe.http === 200 && !probe.error && meta?.package === "chattrn/connector" && meta.framework === "Laravel" &&
      typeof meta.api_path === "string" && /^\/(?!\/)[a-zA-Z0-9_/-]+$/.test(meta.api_path)) {
    return { checked: true, laravel_likely: true, framework: "Laravel", package_status: "installed",
      package_version: typeof meta.package_version === "string" ? meta.package_version.slice(0, 40) : null,
      api_path: meta.api_path, message: "Chattrn package found. Continue with pairing." };
  }
  if (probe.error || probe.http == null || [429, 502, 503, 504].includes(probe.http)) {
    return { checked: false, laravel_likely: null, framework: null, package_status: "unavailable",
      message: "The store may be waking up or temporarily unavailable. Retry discovery; this does not mean it is not Laravel." };
  }
  const home = await transport({ url, method: "GET", timeoutMs: 5000 });
  if (home.error || home.http == null || home.http >= 500 || home.http === 429) {
    return { checked: false, laravel_likely: null, framework: null, package_status: "unavailable",
      message: "Could not identify the store while it is unavailable. Retry shortly or continue if you know it uses Laravel." };
  }
  const laravel = (home.setCookie || []).some(c => /laravel_session|XSRF-TOKEN/i.test(c));
  const marker = MARKERS.find(([, pattern]) => pattern.test(home.text || ""));
  return { checked: true, laravel_likely: laravel ? true : marker ? false : null,
    framework: laravel ? "Laravel" : marker?.[0] || null,
    package_status: probe.http === 404 ? "not_found" : [401, 403].includes(probe.http) ? "protected" : "unknown",
    message: [401, 403].includes(probe.http) ? "Package discovery requires sign-in. Make /.well-known/chattrn.json public or continue manually."
      : laravel ? "Laravel detected; the package discovery endpoint was not found. Install or update the package."
      : marker ? "Another framework was detected. You can still continue if Laravel powers your backend."
      : "No public package endpoint found. Framework is unknown; Laravel cannot be ruled out." };
}
module.exports = { sniffFramework };
