# Chattrn connector backend (Connect a custom website)

Backend for the four-step "Connect a custom website" flow: Store details, Your API (endpoints),
Map fields, Test connection, Delivery setup. It takes over the calls the browser makes in
`public/flow-tester.html`, so the store's key stays on the server.

Covers dev spec **slice 2 (Map my existing API)** plus the parts of **slice 1B** the flow uses
(endpoint checks, test runner, zones). Tested against a local mock store. Nothing is built for one store: each store's fields, zone parameter and paging are found or mapped per store.

## Run

    npm start              # http://localhost:3100  (flow tester at /)
    npm run mock           # local stand-in store at http://127.0.0.1:3101/api/shop, key mock-key-1234567890
    npm test               # 23 tests against the mock

Requires Node 22 or later. No dependencies.

| Variable | Purpose |
|---|---|
| `PORT` | Default 3100 |
| `DATA_DIR` | Where `stores.json` and `.secret` go. Default `./data` |
| `CHATTRN_SECRET` | Master secret for encrypting store keys (16+ characters). If unset, a random one is written to `data/.secret` |
| `ADMIN_TOKEN` | If set, every `/api` call needs the header `X-Admin-Token` |
| `ALLOW_PRIVATE_HOSTS=1` | **Tests and the local mock only.** Allows private IPs and plain HTTP. Never set in production |

## Dashboard sign-in

Set `ADMIN_TOKEN` to a long, random secret in the hosting environment. Render startup refuses
to run without it. Open the dashboard and sign in using that value. The browser receives a
signed, HttpOnly, SameSite=Strict session cookie lasting one hour (Secure in production).
The token is not embedded in HTML or stored in localStorage. Sign out clears the cookie;
rotating ADMIN_TOKEN invalidates existing sessions. Cookie-authenticated writes require
same-origin dashboard requests. Automated clients can continue using X-Admin-Token.

The `/health` readiness endpoint and token-authenticated `/package/register` callback remain
accessible without dashboard sign-in. Login failures are limited to 20 per minute per process.
For this single-admin testing dashboard, everyone with ADMIN_TOKEN has full access; this is
not a multi-user account or role system. Local development without ADMIN_TOKEN stays open.

## Persistent storage on Render

Set `DATABASE_URL` to a PostgreSQL connection string to store connections, encrypted API
credentials, mappings, catalog snapshots, and test results in PostgreSQL. On startup the app
creates its own `chattrn_stores` table and token-hash index, then starts listening. It does
not require deployed shell access. Without `DATABASE_URL`, local development continues to
use `data/stores.json`.

When using PostgreSQL, set a stable `CHATTRN_SECRET` of at least 16 characters (a generated
32+ character secret is recommended). Do not rotate it without re-encrypting existing
credentials. Startup fails if the secret is missing, or database initialization fails;
it never silently falls back to temporary JSON files. Database writes finish before API
success responses are sent. Concurrent changes to the same store are rejected with 409
rather than overwriting newer data.

Use a database in the same Render workspace and region, then copy its **Internal Database
URL** into the web service's `DATABASE_URL` environment variable. The app creates only its
own namespaced table; it can use an existing PostgreSQL database for a test deployment
without changing Laravel's tables. A separate database/user is preferable for isolation.
An external PostgreSQL connection should use TLS with certificate verification (for example,
a provider URL with `sslmode=verify-full`); never disable certificate verification.

Set Render's health-check path to `/health`. It returns 200 only when the app can reach
its storage; a database outage returns 503. No credentials are exposed by that endpoint.

Existing JSON files are not automatically imported. A fresh PostgreSQL deployment starts
with no connections; connect the store again in the live dashboard. Existing installations
that must preserve JSON data need a deliberate import using the original encryption secret.

To run the real PostgreSQL persistence test against a disposable database:

```bash
TEST_DATABASE_URL='postgresql://user:password@localhost/test_database' npm run test:postgres
```

It verifies restarts, token exchange and replay rejection, encryption, saved mappings and
runs, concurrency protection, and outage behavior. Standard `npm test` skips the database
integration test when `TEST_DATABASE_URL` is not set.

## Routes

| Method | Path | What it does |
|---|---|---|
| GET | `/api/stores` | List stores (no keys) |
| POST | `/api/stores` | Create a store: `{name, base_url, website_url, currency, delivery_mode: zone|outlet (required), auth:{mode, header, key}}` |
| GET | `/api/stores/:id` | One store |
| PUT | `/api/stores/:id/auth` | Replace the key. The new key is tested first; if it fails, the old key stays |
| POST | `/api/stores/:id/connection/check` | Product list check (Connected or error) |
| GET | `/api/stores/:id/endpoints` | Registry rows, merged with saved state |
| PUT | `/api/stores/:id/endpoints/:key` | Add or change an endpoint path: `{method, path}` |
| POST | `/api/stores/:id/endpoints/:key/check` | Check one row: `{phone?, number?, query?, id?, zone?}`. Returns Responded, Needs attention, Error or Not checked |
| POST | `/api/stores/:id/mapping/propose` | Match fields from the sample: `{resource: product, variant or zone}` |
| GET | `/api/stores/:id/mapping?resource=` | Saved rows and versions |
| PUT | `/api/stores/:id/mapping` | Save a version: `{resource, rows}`. Refused until required rows match |
| POST | `/api/stores/:id/mapping/rollback` | Back to the previous version |
| GET | `/api/stores/:id/fields?resource=&compatible_with=` | The "Your field" dropdown, compatible fields first |
| GET | `/api/stores/:id/zones` | Zones, mapped to `{id, name}` |
| PUT | `/api/stores/:id/delivery-settings` | `{mode: zone or outlet, ask_area_when, remember_area}`. Sets the zone parameter name only once discovery has confirmed it |
| POST | `/api/stores/:id/location/discover` | Finds the query name the store reads its zone from, by testing candidates against a real zone. Read-only |
| POST | `/api/stores/:id/test-runs` | Test connection: `{phone?, zone?, rediscover?}`. Read-only, under 60 s. Runs discovery first unless the name is already confirmed |
| GET | `/api/stores/:id/test-runs/latest` | Last run |
| GET | `/api/stores/:id/products?page=&query=&zone=` | Products in Chattrn's model, with prices as decimal strings |

Errors use `{"error": {"code", "message"}}`. Messages follow the spec's wording where it gives one.

## How the rules are applied

- **Endpoint check.** Product list is called on page 1 and page 2. It responds only when it gets a JSON array of objects with an id-like and a title-like field, and page 2 differs from page 1. 401 and 403 give Needs attention ("Key can't read …"). 404, 5xx, timeouts and HTML give Error. Over 2 s gives Needs attention. Create and cancel are never called.
- **Field matching.** Rules only: normalised names (lowercase, letters and digits) against synonym lists, then type checks on the sample values. A boolean never matches a number. Two candidates at the same depth and rank give Check this and a question. The AI fallback in the spec is **not built**.
- **Saving.** Required rows must match. `updated_at` may be saved as "not in this store" (see decisions). Check this rows must be confirmed.
- **Test run.** Store profile, Catalog, Product search, Live stock and price (20 calls, p95 at or under 800 ms), Order lookup and Order details (only with a phone you enter; never stored), Cart quote, Cancel order, Update order. Data quality covers 50 products: prices, stock, variant stock, images (HEAD, 2 s, 10 at a time, 95% threshold), all pages (up to 40), money format and speed.
- **Safety.** HTTPS only, public IPs only, no redirects, 10 s timeout per call, 2 MB response cap, 5 requests per second per store, and `X-Chattrn-Test: 1` on every call.

## Decisions to confirm

1. **`updated_at` is required by the tester, but the store may not have it.** The save gate accepts `not_in_store: true` for this one field. Sync would then do full refreshes instead of incremental ones. Nothing else gets this exception.
2. **The zone parameter name** is never assumed. Discovery (`src/location.js`) tests candidate names against a real zone and accepts one only if it changes the product list. Several matches or none is reported. A confirmed name is kept. Outlet mode is found the same way.
3. **Delivery setting values** `always | when_needed | never` for "When should the AI ask for the area?" are my own. The spec does not list them.
4. **Key length** is 1 to 512 characters for mapped stores. The spec's 16 to 512 rule is for Chattrn API stores.
5. **Cart and order write paths** in the registry are proposals only. They are never called.

## Built in this round

- **Location parameter discovery.** Each store's zone parameter is tested, not assumed. Shows as the "Location parameter" check in Test connection, and the confirmed name is kept across saves while the mode stays the same.

- **Zone-aware reads.** Some stores return 200 with an empty list when no zone is sent. Set the zone with `PUT /delivery-settings {zone}`. Without one, the product check tries the first zone and says so.
- **Paging detection.** Page number, offset, cursor (`next_cursor`) and Link header, detected from the first two pages. The walker reads up to 40 pages.
- **Order tab.** Order fields, status value map (raw status to Chattrn status; unmapped statuses block save), `GET /api/stores/:id/orders?phone=`.
- **Customer tab.** Matches phone and ID, never copies the customer, and redacts customer values from stored samples.
- **Coalesce.** A row can set `fallback_path`, used when the primary field is missing.
- **Drift.** A mapped field absent for 3 test runs in a row is flagged, with its fallback if one is set. This counts test runs, not syncs.
- **Extra fields.** Kept under `x_chattrn` with a label.

## Not built yet

- AI fallback for field matching
- Website check (0a, 0b), and endpoint import from OpenAPI or Postman
- "From docs" matching for orders when the order key can't read them
- Sync scheduler, product index and the nightly check
- Chattrn-side gateway, native connector and Actions/Skills (slice 1)
- The limit of 30 endpoint checks per store per minute
- DNS rebinding protection: the address is checked once before each call, not pinned to the connection

## Testing against a store

From your own machine, so the store can be reached from your network:

    npm start
    # open http://localhost:3100, create a store with its base URL and sign-in method,
    # then press Find zone parameter in Delivery setup.

### Consistent connection setup

All three adapters use **Connect → Review → Verify → Activate**. Connection checks
only probe the merchant; activation is explicit. API clients should save their
mapping, POST `/api/stores/:id/onboarding/review`, POST
`/api/stores/:id/test-runs`, then POST `/api/stores/:id/activate`. Activation
requires a passing run for the current reviewed configuration within 15 minutes.
Changes to credentials, endpoints, mapping or delivery mode require review and
verification again. Endpoint diagnostic timestamps do not invalidate a review.

Outbound merchant requests pin validated DNS addresses to their connections,
refuse private/reserved destinations and redirects, limit streamed encoded and
decoded bodies, and apply one deadline across DNS and response processing.
Requests to the same origin share a throttle. Private-host testing is unavailable
in production and on Render.

The canonical PHP source and release CI live in
[sahnewajsojib123/chattrn-connector](https://github.com/sahnewajsojib123/chattrn-connector).
The former embedded package directory contains a pointer only. Backend CI tests
Node 22/24 with PostgreSQL and checks that duplicate PHP sources do not return.

### One connected store per brand

`GET /api/brands` supplies five default test identities, Brand A through Brand E,
plus existing legacy brand assignments. All three setup forms use this directory.
Occupied brands are disabled unless editing their own connection. New connections
may only choose a directory brand; brand names are compared without surrounding
spaces or case differences. A brand is required at activation.

The backend rejects occupied brands during creation and activation with HTTP 409
`brand_in_use`. Drafts do not reserve a brand. Disconnecting releases the brand;
reconnecting a former store cannot displace its replacement. Configuration reviews
include the assigned brand. PostgreSQL's partial unique index arbitrates concurrent
activation, across processes and connection options. JSON development storage checks
the same invariant before persisting a connected store.

Before deploying onto an existing database, check for duplicate active assignments:

```sql
SELECT lower(btrim(document->>'brand')) AS brand, array_agg(id) AS store_ids
FROM chattrn_stores
WHERE document->>'status' = 'connected'
  AND nullif(btrim(document->>'brand'), '') IS NOT NULL
GROUP BY lower(btrim(document->>'brand'))
HAVING count(*) > 1;
```

If duplicates exist, disconnect the extra stores in the current dashboard before
deploying. The migration refuses duplicates and does not choose a winner or delete
connections. This standalone tester's seeded brands are connection identities;
they do not provision AI agents or knowledge bases in an external Chattrn account.
When integrating with Chattrn's brand directory, use its immutable brand IDs as
this identity, retaining the database uniqueness rule.

### Whole-store catalog and customer location

Connecting a store never picks a customer's zone/outlet. Mapped endpoint checks
find representative samples automatically, scanning beyond empty locations with a
bounded, resumable discovery cursor. A sample location is diagnostic only; legacy
`delivery.zone_value` defaults are ignored. Verification reports sample coverage
separately from the full catalog import.

After a reviewed connection passes verification, a durable catalog job imports all
locations and every product page. Existing connected stores bootstrap an import on
startup. Native Chattrn API and Laravel connections import the global catalog once,
then read inventory in batches for every location. Mapped APIs with a discovered
location parameter traverse every location. Products are deduplicated by ID; prices,
stock and variant offers are stored separately by location. Descriptions and common
product information are retained once rather than copied into every offer.

- `POST /api/stores/:id/catalog/sync` returns **202**, not a synchronous completion
  result. `{ "retry": true }` resumes failed work; completed locations are retained.
- `GET /api/stores/:id/catalog/status` reports phase, product count, location coverage,
  failures and completion. Partial, stale and interrupted imports never claim complete.
- `GET /api/stores/:id/catalog?limit=50&offset=0` pages through the union. The response
  includes `next_offset`; `?zone=ID` selects a cached location snapshot. Cached offers
  are diagnostic snapshots, not live customer quotes.
- `POST /api/stores/:id/product-lookup` accepts `{ "query": "Do you have rice?" }`.
  Without a location it returns shared information and a location question with
  location-dependent price/stock withheld. Add `location_id` or an unambiguous `area`
  to get live detail/inventory reads. Failures never fall back to cached stock.
  Unknown inventory remains null rather than inheriting another location's quantity.

The caller stores a customer's location on that conversation and passes it to each
lookup. This repo supplies the lookup contract and tester, not a separate production
AI Agent or inbox service. One-store-per-brand enforcement is unchanged.

Jobs checkpoint pages and inventory batches in PostgreSQL, use leases and a separate
catalog revision, and survive restarts without overwriting merchant edits. A crashed
lease can take up to two minutes to expire. Three bounded failures pause work for an
explicit retry. Connected stores refresh hourly while the web service is running.
Render Free sleeping pauses work; it resumes on wake/startup. This does not provide
an always-on worker guarantee. No additional Render service or environment variable
is required by this implementation.

Current snapshot limits are 100,000 unique products, 10,000 product pages and 32 MB.
Exceeding a limit is reported as an incomplete import. Listing stores excludes bulk
catalog/build data. The previous completed snapshot is retained during refresh;
partial builds remain explicitly marked incomplete.

Connector 1.3.1 adds `location_prices` capability and optional `price` /
`compare_at_price` inventory-level fields. These preserve location-specific prices
from the configured inventory model. Flat product stock works without a separate
Variant model and is only returned for the default location. Older native APIs that
only expose global product prices retain that contract; location-dependent prices
must be exposed explicitly, never inferred from a primary-location sample.
