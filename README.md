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
