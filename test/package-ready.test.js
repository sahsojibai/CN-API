"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ensurePackageReady } = require("../src/package-ready");

test("waits for a sleeping package using only reads", async () => {
  const replies = [{ http: 502 }, { http: null, error: "timeout" }, { http: 200, json: { store: {} } }];
  let requests = 0;
  await ensurePackageReady({}, {}, { pause: async () => {}, call: async (_ctx, _store, options) => {
    assert.equal(options.path, "/store.json");
    assert.equal(options.method, undefined);
    return replies[requests++];
  } });
  assert.equal(requests, 3);
});
test("unavailable store has bounded retries and rejected credentials are not retried", async () => {
  let requests = 0;
  await assert.rejects(ensurePackageReady({}, {}, { pause: async () => {}, call: async () => { requests++; return { http: 503 }; } }), e => e.status === 503 && e.code === "package_waking");
  assert.equal(requests, 4);
  requests = 0;
  await assert.rejects(ensurePackageReady({}, {}, { pause: async () => {}, call: async () => { requests++; return { http: 401 }; } }), e => e.code === "package_auth_failed");
  assert.equal(requests, 1);
});
