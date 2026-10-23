"use strict";
const { createHash } = require("node:crypto");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

function configurationStamp(store) {
  // Endpoint probes update diagnostics during verification. Only settings belong in the stamp.
  const endpoints = store.endpoints && Object.fromEntries(Object.entries(store.endpoints).map(([key, value]) => [
    key, { method: value.method, path: value.path, added: value.added },
  ]));
  const settings = {
    type: store.connection_type,
    base: store.base_url,
    auth: store.auth,
    chattrn: store.chattrn && { base: store.chattrn.base_url, credential: store.chattrn.access_token_enc },
    endpoints,
    mapping: store.mapping,
    delivery_mode: store.delivery?.mode,
    package_mapping: store.onboarding?.mapping_saved_at,
  };
  return createHash("sha256").update(JSON.stringify(stable(settings))).digest("hex");
}

function activationProblem(store, now = Date.now()) {
  const stamp = configurationStamp(store);
  const run = store.test_runs?.[0];
  if (store.onboarding?.review_stamp !== stamp) return "Review the current configuration before activating.";
  if (!run || run.can_continue !== true || run.configuration_stamp !== stamp) {
    return "Run verification successfully for the current configuration before activating.";
  }
  const age = now - Date.parse(run.finished_at);
  if (!Number.isFinite(age) || age < 0 || age > 15 * 60000) return "Verification expired. Run the checks again before activating.";
  if (!["zone", "outlet"].includes(store.delivery?.mode)) return "Choose the delivery mode before activating.";
  return null;
}

module.exports = { configurationStamp, activationProblem };
