"use strict";
process.env.ALLOW_PRIVATE_HOSTS = "1";
process.env.CHATTRN_SECRET = "laravel-flow-test-secret";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../src/server");

test("Laravel pairing before mapping, validation errors, and native product previews", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "laravel-flow-"));
  const store = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url.endsWith("mapping/preview.json")) return res.end(JSON.stringify({ cards: [{ title: "Draft columns", groups: [] }] }));
    if (req.url.endsWith("mapping.json")) {
      if (req.method === "PUT") {
        res.writeHead(422);
        return res.end(JSON.stringify({ error: { code: "invalid_mapping", message: "Choose currency." }, errors: { "store.currency": ["Choose currency."] } }));
      }
      return res.end(JSON.stringify({ cards: [{ title: "Products", groups: [] }] }));
    }
    return res.end(JSON.stringify({ products: [{ id: 1, title: "Phone", images: [{ src: "https://store.test/phone.jpg" }], variants: [{ id: 1, price: "20.00", inventory_quantity: 3 }] }] }));
  });
  const app = createApp({ dataDir, publicDir: path.join(__dirname, "../public") });
  const listen = (server) => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
  const site = await listen(store);
  const base = await listen(app.server);
  const api = async (method, route, body) => {
    const res = await fetch(base + route, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const created = await api("POST", "/api/stores", { name: "Laravel", website_url: site, connection_type: "laravel_package", delivery_mode: "outlet" });
    assert.equal(created.status, 201);
    const id = created.body.id;
    const issued = await api("POST", `/api/stores/${id}/laravel/connection-token`, {});
    const token = issued.body.token;
    assert.ok(token);
    const registered = await api("POST", "/package/register", { token, site_url: site, route_prefix: "/chattrn/api/2026-10" });
    assert.equal(registered.status, 200);
    const cards = await api("GET", `/api/stores/${id}/laravel/tables`);
    assert.equal(cards.status, 200);
    assert.equal(cards.body.cards[0].title, "Products");
    const draft = await api("POST", `/api/stores/${id}/laravel/mapping/preview`, { values: { "models.product": "Draft" } });
    assert.equal(draft.status, 200);
    assert.equal(draft.body.cards[0].title, "Draft columns");
    const invalid = await api("PUT", `/api/stores/${id}/laravel/mapping`, { values: { "store.currency": null } });
    assert.equal(invalid.status, 422);
    assert.deepEqual(invalid.body.errors["store.currency"], ["Choose currency."]);
    const preview = await api("GET", `/api/stores/${id}/products`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.products[0].title, "Phone");
    assert.equal(preview.body.products[0].variants[0].stock, 3);
    assert.equal(preview.body.products[0].images[0], "https://store.test/phone.jpg");
  } finally {
    app.server.closeAllConnections();
    store.closeAllConnections();
    await Promise.all([new Promise(resolve => app.server.close(resolve)), new Promise(resolve => store.close(resolve))]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
