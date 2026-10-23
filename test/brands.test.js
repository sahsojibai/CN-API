"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Db } = require("../src/db");
const { PostgresDb } = require("../src/postgres-db");
const { createApp } = require("../src/server");
const { configurationStamp } = require("../src/onboarding");
const { brandDirectory } = require("../src/brands");

function ready(id, brand, type) {
  const store = { id, name: id, brand, status: "draft", connection_type: type,
    delivery: { mode: "outlet" }, onboarding: {}, test_runs: [] };
  store.onboarding.review_stamp = configurationStamp(store);
  store.test_runs = [{ can_continue: true, finished_at: new Date().toISOString(), configuration_stamp: configurationStamp(store) }];
  return store;
}

test("all adapters enforce brand exclusivity, disconnect releases it, reconnect cannot steal it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brand-rule-"));
  const app = createApp({ dataDir: dir, publicDir: path.join(__dirname, "../public"), adminToken: "" });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (route, body, method = "POST") => {
    const res = await fetch(base + route, { method, headers: { "Content-Type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body || {}) });
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.equal((await api("/api/stores", {name:"Unknown brand", brand:"Not a brand",connection_type:"laravel_package",delivery_mode:"outlet"})).status, 422);
    const catalog = await api("/api/brands", null, "GET");
    assert.deepEqual(catalog.body.brands.map(b => b.name), ["Brand A", "Brand B", "Brand C", "Brand D", "Brand E"]);
    for (const [id, type] of [["a", "mapped_api"], ["b", "chattrn_api"], ["c", "laravel_package"]]) app.db.put(ready(id, "Brand A", type));
    assert.equal((await api("/api/stores/a/activate")).status, 200);
    for (const id of ["b", "c"]) {
      const res = await api(`/api/stores/${id}/activate`);
      assert.equal(res.status, 409); assert.equal(res.body.error.code, "brand_in_use");
      assert.equal(app.db.find(id).status, "draft");
    }
    const refused = await api("/api/stores", { name: "Other", brand: " brand a ", connection_type: "laravel_package", delivery_mode: "outlet" });
    assert.equal(refused.status, 409);
    assert.equal((await api("/api/stores/a/disconnect")).status, 200);
    assert.equal((await api("/api/stores/b/activate")).status, 200);
    assert.equal((await api("/api/stores/a/activate")).status, 409);
    const occupied = (await api("/api/brands", null, "GET")).body.brands[0];
    assert.equal(occupied.connected_store_id, "b");
    app.db.put(ready("d", "Brand B", "laravel_package"));
    assert.equal((await api("/api/stores/d/activate")).status, 200);
    app.db.put(ready("missing", null, "mapped_api"));
    assert.equal((await api("/api/stores/missing/activate")).status, 422);
    assert.equal(brandDirectory(app.db.list()).length, 5);
    const persisted = new Db(path.join(dir, "stores.json"));
    const duplicate = persisted.find("c"); duplicate.status = "connected";
    assert.throws(() => persisted.put(duplicate), e => e.code === "brand_in_use");
    assert.equal(persisted.find("c").status, "draft");
  } finally {
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("PostgreSQL unique index arbitrates concurrent activation across connections", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const first = await new PostgresDb(process.env.TEST_DATABASE_URL).init();
  const second = await new PostgresDb(process.env.TEST_DATABASE_URL).init();
  const ids = [randomUUID(), randomUUID()];
  const brand = "concurrent-" + randomUUID();
  try {
    await first.put(ready(ids[0], brand, "mapped_api"));
    await second.put(ready(ids[1], " " + brand.toUpperCase() + " ", "laravel_package"));
    const a = await first.find(ids[0]), b = await second.find(ids[1]);
    a.status = b.status = "connected";
    const outcomes = await Promise.allSettled([first.put(a), second.put(b)]);
    assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(outcomes.find(r => r.status === "rejected").reason.code, "brand_in_use");
    const winner = outcomes[0].status === "fulfilled" ? a : b;
    const winnerDb = winner === a ? first : second, loserDb = winner === a ? second : first;
    winner.status = "disconnected"; await winnerDb.put(winner);
    const loser = await loserDb.find(winner === a ? b.id : a.id);
    loser.status = "connected"; await loserDb.put(loser);
    assert.equal((await loserDb.find(loser.id)).status, "connected");
    assert.equal((await new PostgresDb(process.env.TEST_DATABASE_URL).init().then(async db => { try { return (await db.find(loser.id)).brand; } finally { await db.close(); } })), loser.brand);
  } finally {
    await first.pool.query("DELETE FROM chattrn_stores WHERE id = ANY($1::text[])", [ids]);
    await Promise.all([first.close(), second.close()]);
  }
});

test("brand migration refuses legacy duplicate connections without deleting them", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = "brand_migration_" + randomUUID().replaceAll("-", "");
  let db;
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE ${schema}.chattrn_stores (id text PRIMARY KEY, document jsonb NOT NULL, revision bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now())`);
    for (const id of ["legacy-a", "legacy-b"]) {
      await pool.query(`INSERT INTO ${schema}.chattrn_stores (id,document) VALUES ($1,$2::jsonb)`, [id, JSON.stringify({id,brand:"Brand A",status:"connected"})]);
    }
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set("options", `-c search_path=${schema}`);
    db = new PostgresDb(url.toString());
    await assert.rejects(db.init(), /Disconnect duplicate connections/);
    assert.equal((await pool.query(`SELECT count(*) FROM ${schema}.chattrn_stores`)).rows[0].count, "2");
  } finally {
    if (db) await db.close();
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  }
});
