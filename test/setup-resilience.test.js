"use strict";
process.env.ALLOW_PRIVATE_HOSTS = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path");
const Drafts = require("../public/onboarding-drafts");
const { sniffFramework } = require("../src/framework-sniff");
const { createApp } = require("../src/server");

test("package discovery wins over absent homepage fingerprints without sending auth", async () => {
  const calls = [];
  const found = await sniffFramework("https://store.test/", async opts => {
    calls.push(opts); return { http: 200, json: { package: "chattrn/connector", framework: "Laravel", api_path: "/custom/api", package_version: "1.2.2" } };
  });
  assert.equal(found.package_status, "installed"); assert.equal(found.laravel_likely, true);
  assert.equal(found.api_path, "/custom/api"); assert.equal(calls.length, 1);
  assert.equal(calls[0].headers, undefined);
  assert.equal(calls[0].url, "https://store.test/.well-known/chattrn.json");
});
test("sleeping stores are unavailable, unknown pages are not declared non-Laravel", async () => {
  const sleeping = await sniffFramework("https://store.test", async () => ({ http: 503 }));
  assert.equal(sleeping.package_status, "unavailable"); assert.equal(sleeping.laravel_likely, null);
  const unknown = await sniffFramework("https://store.test", async opts => opts.url.includes("well-known") ? { http: 404 } : { http: 200, text: "Custom shop", setCookie: [] });
  assert.equal(unknown.laravel_likely, null); assert.equal(unknown.package_status, "not_found");
  const laravel = await sniffFramework("https://store.test", async opts => opts.url.includes("well-known") ? { http: 404 } : { http: 200, setCookie: ["custom_XSRF-TOKEN=yes"] });
  assert.equal(laravel.laravel_likely, true);
});
test("discovery rejects external API paths and treats login pages as inconclusive", async () => {
  const result = await sniffFramework("https://store.test", async opts => opts.url.includes("well-known") ? { http: 200, json: { package: "chattrn/connector", framework: "Laravel", api_path: "//evil.test/api" } } : { http: 401, text: "Sign in" });
  assert.notEqual(result.package_status, "installed"); assert.equal(result.laravel_likely, null);
});
test("browser draft roundtrip excludes credentials, samples and query secrets", () => {
  const data = new Map(); const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  const saved = Drafts.save(storage, { kind: "laravel_package", step: 2, fields: { lSiteUrl: "https://shop.test/?secret=LEAK", lStoreName: "Shop", lAccessToken: "LEAK" },
    access_token: "LEAK", samples: [{ phone: "LEAK" }], laravel_values: { "models.product": "App\\Models\\Product", "store.access_token": "LEAK" } });
  assert.doesNotMatch(JSON.stringify(saved), /LEAK/);
  const restored = Drafts.load(storage, "laravel_package");
  assert.equal(restored.fields.lSiteUrl, "https://shop.test/"); assert.equal(restored.step, 2);
  assert.equal(restored.laravel_values["models.product"], "App\\Models\\Product");
  assert.equal(Drafts.load(storage, "laravel_package", Date.now() + Drafts.TTL + 1000), null);
  storage.setItem("chattrn.draft.v1.laravel_package", "invalid-json"); assert.equal(Drafts.load(storage, "laravel_package"), null);
  assert.throws(() => Drafts.sanitize({ kind: "unknown" }));
});
test("draft APIs retain configuration across app restart, hide content in lists and support discard", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-drafts-"));
  let app = createApp({ dataDir, publicDir: path.join(__dirname, "../public"), secretKey: Buffer.alloc(32, 1) });
  const listen = () => new Promise(resolve => app.server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${app.server.address().port}`)));
  let base = await listen();
  const api = async (method, route, body) => { const res = await fetch(base + route, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  const close = async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); };
  try {
    for (const kind of Drafts.KINDS) {
      const created = await api("POST", "/api/stores", { name: "Shop", connection_type: kind, delivery_mode: "outlet", website_url: "https://shop.test", base_url: "http://127.0.0.1/api" });
      assert.equal(created.status, 201); const id = created.body.id;
      const saved = await api("PUT", `/api/stores/${id}/onboarding-draft`, { kind, store_id: id, fields: { lStoreName: "Shop" }, laravel_values: { "models.product": "ExampleProduct", "store.secret": "LEAK" }, token: "LEAK" });
      assert.equal(saved.status, 200); assert.doesNotMatch(JSON.stringify(saved.body), /LEAK/);
      await close(); app = createApp({ dataDir, publicDir: path.join(__dirname, "../public"), secretKey: Buffer.alloc(32, 1) }); base = await listen();
      const restored = await api("GET", `/api/stores/${id}/onboarding-draft`);
      assert.equal(restored.body.draft.laravel_values["models.product"], "ExampleProduct");
      const list = await api("GET", "/api/stores");
      assert.ok(list.body.stores.find(s => s.id === id).onboarding_draft_saved_at);
      assert.doesNotMatch(JSON.stringify(list.body), /ExampleProduct/);
      assert.equal((await api("PUT", `/api/stores/${id}/onboarding-draft`, { kind: kind === "mapped_api" ? "chattrn_api" : "mapped_api" })).status, 409);
      assert.equal((await api("DELETE", `/api/stores/${id}/onboarding-draft`)).status, 200);
      assert.equal((await api("GET", `/api/stores/${id}/onboarding-draft`)).body.draft, null);
    }
  } finally { await close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
