"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { PostgresDb } = require("../src/postgres-db");
const { createConfiguredApp } = require("../src/server");
const { decrypt } = require("../src/crypto");
const { Pool } = require("pg");

// Point only at a disposable test database: this suite creates/deletes its own store rows.
test("PostgreSQL persists pairing and test results across app restarts and rejects stale writes", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const previousSecret = process.env.CHATTRN_SECRET;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cnapi-pg-test-"));
  const ids = [];
  const apps = [];
  let pool;
  process.env.CHATTRN_SECRET = "stable-postgres-test-secret-only";
  const options = { databaseUrl: process.env.TEST_DATABASE_URL, dataDir, publicDir: path.join(__dirname, "../public"), adminToken: "admin-test" };
  const launch = async () => {
    const app = await createConfiguredApp(options);
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    app.base = `http://127.0.0.1:${app.server.address().port}`;
    apps.push(app);
    return app;
  };
  const stop = async app => {
    if (app.stopped) return;
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await app.db.close();
    app.stopped = true;
  };
  const api = async (app, method, route, body, token = "admin-test") => {
    const response = await fetch(app.base + route, { method, headers: { "Content-Type": "application/json", "X-Admin-Token": token }, body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    let app = await launch();
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    assert.deepEqual((await api(app, "GET", "/health", undefined, "")).body, { ok: true, storage: "postgres" });
    assert.equal((await api(app, "GET", "/api/stores", undefined, "wrong")).status, 401);
    const created = await api(app, "POST", "/api/stores", { name: "Persist me", website_url: "https://example.com", delivery_mode: "outlet", connection_type: "laravel_package" });
    assert.equal(created.status, 201);
    const id = created.body.id;
    ids.push(id);
    const issued = await api(app, "POST", `/api/stores/${id}/laravel/connection-token`, {});
    const token = issued.body.token;
    assert.ok(token);
    await stop(app);
    app = await launch();
    const registered = await api(app, "POST", "/package/register", { token, site_url: "https://example.com", route_prefix: "/chattrn/api/2026-10" }, "");
    assert.equal(registered.status, 200);
    const document = await app.db.find(id);
    assert.equal(decrypt(document.chattrn.access_token_enc, app.ctx.secretKey), registered.body.access_token);
    document.test_runs = [{ id: "saved-test", checks: [{ label: "Catalog", state: "passed" }] }];
    document.mapping = { product: { versions: [{ rows: [{ key: "title", source_path: "name" }] }] } };
    await app.db.put(document);
    const raw = await pool.query("SELECT document FROM chattrn_stores WHERE id=$1", [id]);
    assert.ok(!JSON.stringify(raw.rows).includes(registered.body.access_token));
    assert.ok(!JSON.stringify(raw.rows).includes(token));
    await stop(app);
    app = await launch();
    const loaded = await app.db.find(id);
    assert.equal(loaded.test_runs[0].id, "saved-test");
    assert.equal(loaded.mapping.product.versions[0].rows[0].source_path, "name");
    assert.equal(decrypt(loaded.chattrn.access_token_enc, app.ctx.secretKey), registered.body.access_token);
    assert.equal((await api(app, "GET", `/api/stores/${id}/test-runs/latest`)).body.id, "saved-test");
    assert.equal((await api(app, "GET", `/api/stores/${id}`)).body.chattrn.access_token_enc, undefined);
    assert.equal((await api(app, "POST", "/package/register", { token, site_url: "https://example.com" }, "")).status, 401);
    const stale = await app.db.find(id);
    loaded.name = "New name";
    await app.db.put(loaded);
    stale.name = "Stale overwrite";
    await assert.rejects(app.db.put(stale), error => error.code === "store_changed");
    assert.equal((await app.db.find(id)).name, "New name");
    const pending = { id: randomUUID(), name: "Uncommitted" };
    ids.push(pending.id);
    const query = app.db.pool.query.bind(app.db.pool);
    app.db.pool.query = async () => { throw new Error("simulated outage"); };
    await assert.rejects(app.db.put(pending), /simulated outage/);
    assert.equal((await api(app, "GET", "/health")).status, 503);
    app.db.pool.query = query;
    assert.equal(await app.db.find(pending.id), null);
    assert.equal(fs.existsSync(path.join(dataDir, "stores.json")), false);
  } finally {
    for (const app of apps) await stop(app);
    if (pool) {
      await pool.query("DELETE FROM chattrn_stores WHERE id = ANY($1::text[])", [ids]);
      await pool.end();
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.CHATTRN_SECRET;
    else process.env.CHATTRN_SECRET = previousSecret;
  }
});

test("persistent storage refuses an ephemeral encryption key", async () => {
  const previous = process.env.CHATTRN_SECRET;
  delete process.env.CHATTRN_SECRET;
  try {
    await assert.rejects(createConfiguredApp({ databaseUrl: "postgresql://unused" }), /requires CHATTRN_SECRET/);
  } finally {
    if (previous !== undefined) process.env.CHATTRN_SECRET = previous;
  }
});
