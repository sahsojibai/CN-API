"use strict";
const { Pool } = require("pg");
const { publicView } = require("./db");
const { HttpError } = require("./http");

class PostgresDb {
  constructor(connectionString) {
    this.pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
    this.versions = new WeakMap();
    this.pool.on("error", () => console.error("An idle PostgreSQL connection failed."));
  }

  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS chattrn_stores (
      id text PRIMARY KEY,
      document jsonb NOT NULL,
      revision bigint NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS chattrn_stores_token_hash
      ON chattrn_stores ((document->'laravel'->>'connection_token_hash'))`);
    // The index, rather than a read-before-write check, arbitrates concurrent activations.
    try {
      await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS chattrn_stores_connected_brand
        ON chattrn_stores (lower(btrim(document->>'brand')))
        WHERE document->>'status' = 'connected' AND nullif(btrim(document->>'brand'), '') IS NOT NULL`);
    } catch (error) {
      if (error.code === "23505") throw new Error("Multiple connected stores already share a brand. Disconnect duplicate connections before applying the one-store-per-brand migration.");
      throw error;
    }
    return this;
  }

  materialize(row) {
    if (!row) return null;
    this.versions.set(row.document, row.revision);
    return row.document;
  }

  async list() {
    const result = await this.pool.query("SELECT document FROM chattrn_stores ORDER BY updated_at DESC");
    return result.rows.map(row => publicView(row.document));
  }

  async find(id) {
    const result = await this.pool.query("SELECT document, revision FROM chattrn_stores WHERE id = $1", [id]);
    return this.materialize(result.rows[0]);
  }

  async findByLaravelTokenHash(hash) {
    const result = await this.pool.query("SELECT document, revision FROM chattrn_stores WHERE document->'laravel'->>'connection_token_hash' = $1", [hash]);
    return this.materialize(result.rows[0]);
  }

  async put(store) {
    if (store.status === "connected" && (typeof store.brand !== "string" || !store.brand.trim())) {
      throw new HttpError(422, "brand_required", "Assign a brand before connecting this store.");
    }
    store.updated_at = new Date().toISOString();
    const revision = this.versions.get(store);
    let result;
    try {
      result = revision == null
      ? await this.pool.query(`INSERT INTO chattrn_stores (id, document) VALUES ($1, $2::jsonb)
          ON CONFLICT (id) DO NOTHING RETURNING revision`, [store.id, JSON.stringify(store)])
      : await this.pool.query(`UPDATE chattrn_stores SET document = $2::jsonb, revision = revision + 1, updated_at = now()
          WHERE id = $1 AND revision = $3 RETURNING revision`, [store.id, JSON.stringify(store), revision]);
    } catch (error) {
      if (error.code === "23505" && error.constraint === "chattrn_stores_connected_brand") {
        throw new HttpError(409, "brand_in_use", "This brand already has a connected store. Disconnect that store before connecting another.");
      }
      throw error;
    }
    if (!result.rowCount) throw new HttpError(409, "store_changed", "This store changed in another request. Reload and try again.");
    this.versions.set(store, result.rows[0].revision);
    return store;
  }

  async ping() {
    await this.pool.query("SELECT id FROM chattrn_stores LIMIT 1");
  }

  async close() {
    await this.pool.end();
  }
}
module.exports = { PostgresDb };
