"use strict";
const { Pool } = require("pg");
const { publicView } = require("./db");
const { HttpError } = require("./http");

class PostgresDb {
  constructor(connectionString) {
    this.pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
    this.versions = new WeakMap();
    this.catalogVersions = new WeakMap();
    this.pool.on("error", () => console.error("An idle PostgreSQL connection failed."));
  }

  async init() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':chattrn-schema')::bigint)");
      await client.query(`CREATE TABLE IF NOT EXISTS chattrn_stores (
        id text PRIMARY KEY,
        document jsonb NOT NULL,
        revision bigint NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      await client.query("ALTER TABLE chattrn_stores ADD COLUMN IF NOT EXISTS catalog_revision bigint NOT NULL DEFAULT 0");
      await client.query(`CREATE INDEX IF NOT EXISTS chattrn_stores_token_hash
        ON chattrn_stores ((document->'laravel'->>'connection_token_hash'))`);
      // The index, rather than a read-before-write check, arbitrates concurrent activations.
      try {
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS chattrn_stores_connected_brand
          ON chattrn_stores (lower(btrim(document->>'brand')))
          WHERE document->>'status' = 'connected' AND nullif(btrim(document->>'brand'), '') IS NOT NULL`);
      } catch (error) {
        if (error.code === "23505") throw new Error("Multiple connected stores already share a brand. Disconnect duplicate connections before applying the one-store-per-brand migration.");
        throw error;
      }
      await client.query(`CREATE INDEX IF NOT EXISTS chattrn_stores_pending_catalog
        ON chattrn_stores (updated_at) WHERE document->'catalog_sync'->>'status' IN ('queued','running')`);
      await client.query("COMMIT");
      return this;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  materialize(row) {
    if (!row) return null;
    this.versions.set(row.document, row.revision);
    this.catalogVersions.set(row.document, row.catalog_revision);
    return row.document;
  }

  async list() {
    const result = await this.pool.query(`SELECT (document - 'catalog_build' - 'catalog' - 'catalog_sync') ||
      CASE WHEN document->'catalog' IS NOT NULL THEN jsonb_build_object('catalog',
        ((document->'catalog') - 'products') || jsonb_build_object('products', '[]'::jsonb,
          'products_total', jsonb_array_length(document->'catalog'->'products'))) ELSE '{}'::jsonb END ||
      CASE WHEN document->'catalog_sync' IS NOT NULL THEN jsonb_build_object('catalog_sync',
        ((document->'catalog_sync') - 'cursor') || jsonb_build_object('products_total',
          jsonb_array_length(COALESCE(document->'catalog_build'->'products',document->'catalog'->'products','[]'::jsonb)))) ELSE '{}'::jsonb END
      AS document FROM chattrn_stores ORDER BY updated_at DESC`);
    return result.rows.map(row => publicView(row.document));
  }

  async find(id) {
    const result = await this.pool.query("SELECT document, revision, catalog_revision FROM chattrn_stores WHERE id = $1", [id]);
    return this.materialize(result.rows[0]);
  }

  async findByLaravelTokenHash(hash) {
    const result = await this.pool.query("SELECT document, revision, catalog_revision FROM chattrn_stores WHERE document->'laravel'->>'connection_token_hash' = $1", [hash]);
    return this.materialize(result.rows[0]);
  }

  async pendingCatalogJobs() {
    const result = await this.pool.query(`SELECT id FROM chattrn_stores WHERE document->'catalog_sync'->>'status' IN ('queued','running')
      OR (document->>'status' = 'connected' AND document->'catalog_sync' IS NULL
        AND (document->>'base_url' IS NOT NULL OR document->'chattrn'->>'base_url' IS NOT NULL))
      OR (document->>'status' = 'connected' AND document->'catalog_sync'->>'status' = 'complete'
        AND (document->'catalog_sync'->>'next_sync_at')::timestamptz <= now()) ORDER BY updated_at LIMIT 20`);
    return result.rows.map(row => row.id);
  }

  async putCatalog(store) {
    const fields = Object.fromEntries(["catalog", "catalog_build", "catalog_sync"].filter(key => store[key] !== undefined).map(key => [key, store[key]]));
    const result = await this.pool.query(`UPDATE chattrn_stores
      SET document = (document - 'catalog' - 'catalog_build' - 'catalog_sync') || $2::jsonb,
          catalog_revision = catalog_revision + 1, updated_at = now()
      WHERE id = $1 AND revision = $3 AND catalog_revision = $4
      RETURNING catalog_revision`, [store.id, JSON.stringify(fields), this.versions.get(store), this.catalogVersions.get(store)]);
    if (!result.rowCount) throw new HttpError(409, "store_changed", "Store changed during the catalog checkpoint.");
    this.catalogVersions.set(store, result.rows[0].catalog_revision);
    return store;
  }

  async put(store, { catalog = false } = {}) {
    if (store.status === "connected" && (typeof store.brand !== "string" || !store.brand.trim())) {
      throw new HttpError(422, "brand_required", "Assign a brand before connecting this store.");
    }
    store.updated_at = new Date().toISOString();
    const revision = this.versions.get(store);
    let result;
    try {
      result = revision == null
      ? await this.pool.query(`INSERT INTO chattrn_stores (id, document) VALUES ($1, $2::jsonb)
          ON CONFLICT (id) DO NOTHING RETURNING revision, catalog_revision, document`, [store.id, JSON.stringify(store)])
      : await this.pool.query(`UPDATE chattrn_stores SET document = CASE WHEN $4::boolean THEN $2::jsonb
            ELSE ($2::jsonb - 'catalog' - 'catalog_build' - 'catalog_sync') ||
              COALESCE((SELECT jsonb_object_agg(key,value) FROM jsonb_each(document) WHERE key IN ('catalog','catalog_build','catalog_sync')), '{}'::jsonb) END,
            revision = revision + 1, catalog_revision = catalog_revision + CASE WHEN $4::boolean THEN 1 ELSE 0 END, updated_at = now()
          WHERE id = $1 AND revision = $3 RETURNING revision, catalog_revision, document`, [store.id, JSON.stringify(store), revision, catalog]);
    } catch (error) {
      if (error.code === "23505" && error.constraint === "chattrn_stores_connected_brand") {
        throw new HttpError(409, "brand_in_use", "This brand already has a connected store. Disconnect that store before connecting another.");
      }
      throw error;
    }
    if (!result.rowCount) throw new HttpError(409, "store_changed", "This store changed in another request. Reload and try again.");
    this.versions.set(store, result.rows[0].revision);
    this.catalogVersions.set(store, result.rows[0].catalog_revision);
    if (result.rows[0].document) {
      for (const key of ["catalog", "catalog_build", "catalog_sync"]) {
        if (result.rows[0].document[key] === undefined) delete store[key]; else store[key] = result.rows[0].document[key];
      }
    }
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
