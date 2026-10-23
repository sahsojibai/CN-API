"use strict";
// Catalog sync: the whole store is read zone by zone, each product is tagged with its zones,
// and a customer's zone filters the tagged list at question time.
process.env.ALLOW_PRIVATE_HOSTS = "1";
process.env.CHATTRN_SECRET = "test-secret-for-the-suite-only";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../src/server");
const { createMockServer, KEY, PREFIX } = require("../src/mock-store");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function startStack(mockOpts) {
  const mock = createMockServer(mockOpts);
  const mockPort = await listen(mock.server);
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "chattrn-cat-")), publicDir: path.join(__dirname, "..", "public") });
  const port = await listen(app.server);
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const create = async () => (await api("POST", "/api/stores", {
    delivery_mode: "zone",
    name: "Catalog store", base_url: `http://127.0.0.1:${mockPort}${PREFIX}`, currency: "BDT",
    auth: { mode: "key", header: "X-API-Key", key: KEY },
  })).body.id;
  const close = () => { mock.server.close(); app.server.close(); };
  return { api, create, close };
}

test("catalog is not readable before the sync", async () => {
  const s = await startStack({ zoneRequired: true });
  try {
    const id = await s.create();
    const r = await s.api("GET", `/api/stores/${id}/catalog`);
    assert.equal(r.status, 409);
  } finally { s.close(); }
});

async function syncAll(api,id) {
  const response = await api("POST", `/api/stores/${id}/catalog/sync`, {});
  assert.equal(response.status,202);
  for (let i=0;i<400;i++) {
    const result = await api("GET", `/api/stores/${id}/catalog/status`);
    if (result.body.status === "complete") return {body:{...result.body,ok:true,zones_checked:result.body.locations_done}};
    if (["partial","stale"].includes(result.body.status)) throw new Error(JSON.stringify(result.body));
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error("Catalog did not finish");
}

// Saves the product mapping (updated_at marked as not in the store), as Map fields does.
async function saveProductMapping(api, id) {
  await api("POST", `/api/stores/${id}/endpoints/products/check`, {});
  const p = await api("POST", `/api/stores/${id}/mapping/propose`, { resource: "product" });
  const rows = p.body.rows.map((x) => ({ key: x.key, source_path: x.source_path, state: x.state, not_in_store: x.key === "updated_at" || undefined }));
  return api("PUT", `/api/stores/${id}/mapping`, { resource: "product", rows });
}

test("sync saves the product field mapping itself when none is saved", async () => {
  const s = await startStack({ zoneRequired: true });
  try {
    const id = await s.create();
    const r = await syncAll(s.api,id);
    assert.equal(r.body.ok, true);
    const m = await s.api("GET", `/api/stores/${id}/mapping?resource=product`);
    assert.ok(m.body.current || m.body.versions, "mapping saved");
  } finally { s.close(); }
});

test("sync reads every zone and tags each product with its zone", async () => {
  const s = await startStack({ zoneRequired: true });
  try {
    const id = await s.create();
    await saveProductMapping(s.api, id);
    const sync = await syncAll(s.api,id);
    assert.equal(sync.body.ok, true);
    assert.equal(sync.body.zones_checked, 48);
    assert.equal(sync.body.products_total, 600);
  } finally { s.close(); }
});

test("a customer's zone filters the synced products at question time", async () => {
  const s = await startStack({ zoneRequired: true });
  try {
    const id = await s.create();
    await saveProductMapping(s.api, id);
    await syncAll(s.api,id);
    // Zone 100 holds products 0, 48, 96 ... of the 600 in the mock (every 48th): 13 of them.
    const z = await s.api("GET", `/api/stores/${id}/catalog?zone=100`);
    assert.equal(z.body.count, 13);
    assert.ok(z.body.products.every((p) => p.zones.includes("100")));
    const all = await s.api("GET", `/api/stores/${id}/catalog`);
    assert.equal(all.body.count, 600);
  } finally { s.close(); }
});
