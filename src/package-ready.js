"use strict";
const CL = require("./chattrn-client");
const { HttpError } = require("./http");

// Only retry this read. A failed PUT can have committed before its response was lost.
async function ensurePackageReady(ctx, store, options = {}) {
  const call = options.call || CL.call;
  const pause = options.pause || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await call(ctx, store, { path: "/store.json", timeoutMs: 12000 });
    if (result.http === 200 && result.json && result.json.store) return;
    if (result.http === 401 || result.http === 403) {
      throw new HttpError(422, "package_auth_failed", "The Laravel store rejected its access token. Check the store connection before saving.");
    }
    const transient = result.error === "timeout" || result.error === "network" || [502, 503, 504].includes(result.http);
    if (!transient) throw new HttpError(502, "package_unreachable", "The Laravel package did not answer its readiness check. Check the package URL and deployment.");
    if (attempt < 3) await pause(1000);
  }
  throw new HttpError(503, "package_waking", "Your Laravel store is still waking up or temporarily unavailable. Your draft is kept here. Wait a moment and save again.");
}
module.exports = { ensurePackageReady };
