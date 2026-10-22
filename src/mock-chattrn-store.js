"use strict";
// A local stand-in for a real Chattrn API store (devspec.txt: "The Chattrn API contract"), already
// in the canonical Shopify-shaped model. Use it to test the native connector without a real store.
//   node src/mock-chattrn-store.js    -> http://127.0.0.1:3102/chattrn/api/2026-10
// Auth: X-Chattrn-Access-Token: chattrn-mock-token-0000000000
//
// Options (tests use these):
//   ordersLocked: true        orders.json and customers/search.json return 403
//   cartMissing: true         draft_orders.json returns 404 (cart not built)
//   slowStock: true           GET /products/:id.json takes ~2.4s
//   missingStockOn: 0.2       that fraction of products report inventory_management: null
//   brokenImages: true        image src points at a 404
//   repeatPage: true          page 2 repeats page 1 (broken pagination)
const http = require("node:http");

const TOKEN = "chattrn-mock-token-0000000000";
const PREFIX = "/chattrn/api/2026-10";
const PAGE_SIZE = 50;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

const LOCATIONS = [
  { id: 900001, name: "Dhanmondi zone", country_code: "BD", active: true, x_chattrn: { type: "zone", areas: ["Dhanmondi", "Mohammadpur"], min_order: "500.00" } },
  { id: 900002, name: "Gulshan zone", country_code: "BD", active: true, x_chattrn: { type: "zone", areas: ["Gulshan", "Banani"], min_order: "500.00" } },
];

function makeProducts(opts) {
  return Array.from({ length: 60 }, (_, i) => {
    const id = 632900000 + i;
    const stock = i % 11 === 0 ? 0 : (i * 7) % 50;
    const missingStock = Math.random() < (opts.missingStockOn || 0);
    const hasVariants = i % 3 === 0;
    const variants = hasVariants
      ? [
          { id: id * 10 + 1, product_id: id, title: "Black / 256GB", option1: "Black", option2: "256GB", option3: null,
            price: (19990 + (i % 10) * 100).toFixed(2), compare_at_price: i % 4 === 0 ? (21500 + (i % 10) * 100).toFixed(2) : null,
            sku: `SKU-${id}-1`, barcode: null, inventory_item_id: 340000 + i * 2,
            inventory_quantity: missingStock ? null : stock, inventory_management: missingStock ? null : "shopify", inventory_policy: "deny" },
          { id: id * 10 + 2, product_id: id, title: "Blue / 128GB", option1: "Blue", option2: "128GB", option3: null,
            price: (17990 + (i % 10) * 100).toFixed(2), compare_at_price: null,
            sku: `SKU-${id}-2`, barcode: null, inventory_item_id: 340000 + i * 2 + 1,
            inventory_quantity: missingStock ? null : Math.floor(stock / 2), inventory_management: missingStock ? null : "shopify", inventory_policy: "deny" },
        ]
      : [
          { id: id * 10 + 1, product_id: id, title: "Default", option1: null, option2: null, option3: null,
            price: (999 + (i % 20) * 50).toFixed(2), compare_at_price: null,
            sku: `SKU-${id}`, barcode: null, inventory_item_id: 340000 + i * 2,
            inventory_quantity: missingStock ? null : stock, inventory_management: missingStock ? null : "shopify", inventory_policy: "deny" },
        ];
    return {
      id, title: `Phone ${String.fromCharCode(65 + (i % 26))}${i}`, handle: `phone-${i}`,
      body_html: "<p>6.5 inch display, 5000 mAh battery.</p>", vendor: "Sumash Tech", product_type: "Smartphone",
      status: "active", tags: "5G, Android", created_at: "2026-09-01T10:00:00+06:00", updated_at: "2026-10-11T18:20:00+06:00",
      options: hasVariants ? [{ id: 1, name: "Color", position: 1, values: ["Black", "Blue"] }, { id: 2, name: "Storage", position: 2, values: ["256GB", "128GB"] }] : [],
      variants,
      images: [{ id: id * 100, position: 1, src: opts.brokenImages ? `http://localhost:1/broken-${id}.jpg` : `http://{host}${PREFIX}/img/${id}.png`, width: 1200, height: 1200, variant_ids: variants.map((v) => v.id) }],
      _location: LOCATIONS[i % LOCATIONS.length].id,
      _zoneStock: { [LOCATIONS[0].id]: stock, [LOCATIONS[1].id]: Math.max(0, stock - 3) },
    };
  });
}

const ORDERS = [
  { id: 5501, name: "#1042", order_number: 1042, phone: "+8801700000000", email: "t@example.com", created_at: "2026-10-10T09:00:00+06:00",
    currency: "BDT", subtotal_price: "19990.00", total_discounts: "0.00", total_tax: "0.00", total_price: "20050.00",
    financial_status: "paid", fulfillment_status: "fulfilled", cancelled_at: null, cancel_reason: null, payment_gateway_names: ["cod"],
    customer: { id: 7701, first_name: "Test", last_name: "Customer" },
    shipping_address: { name: "Test Customer", address1: "House 1", city: "Dhaka", zip: "1209", country_code: "BD", phone: "+8801700000000" },
    line_items: [{ id: 1, variant_id: 6329000001, product_id: 632900000, title: "Phone A0", variant_title: "Black / 256GB", sku: "SKU-632900000-1", quantity: 1, price: "19990.00" }],
    shipping_lines: [{ code: "DHAKA-STD", title: "Inside Dhaka", price: "60.00" }],
    fulfillments: [{ id: 1, order_id: 5501, status: "success", tracking_company: "Pathao", tracking_number: "PT-1", tracking_url: "https://pathao.com/track/PT-1", shipment_status: "delivered", created_at: "2026-10-11T09:00:00+06:00" }] },
];

const CUSTOMERS = [{ id: 7701, phone: "+8801700000000", email: "t@example.com", first_name: "Test", last_name: "Customer", orders_count: 1, total_spent: "20050.00", created_at: "2026-09-01T10:00:00+06:00" }];

function createMockChattrnStore(opts = {}) {
  const products = makeProducts(opts);
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push({ method: req.method, path: url.pathname, search: url.search });
    const host = req.headers.host;
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", "X-Chattrn-API-Version": "2026-10", ...headers });
      res.end(JSON.stringify(body));
    };

    if (url.pathname.startsWith(`${PREFIX}/img/`)) {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": PNG.length });
      return res.end(req.method === "HEAD" ? undefined : PNG);
    }
    if (!url.pathname.startsWith(PREFIX)) return send(404, { errors: "Not Found" });
    if (req.headers["x-chattrn-access-token"] !== TOKEN) return send(401, { errors: "Invalid access token" });

    const route = url.pathname.slice(PREFIX.length) || "/";
    const q = url.searchParams;

    if (route === "/store.json") {
      return send(200, {
        store: {
          name: "Sumash Tech", domain: "sumashtech.com", currency: "BDT", country_code: "BD", iana_timezone: "Asia/Dhaka",
          api_version: "2026-10", delivery_mode: "zone",
          capabilities: {
            products: true, product_search: true, inventory_levels: true, locations_resolve: true,
            customers_search: !opts.ordersLocked, orders_read: !opts.ordersLocked, orders_cancel: true,
            draft_orders: !opts.cartMissing, draft_orders_complete: !opts.cartMissing, delivery_rates: true,
          },
          product_url_template: "https://sumashtech.com/product/{handle}",
          cart_url_template: "https://sumashtech.com/cart?variant={variant_id}&quantity={quantity}",
        },
      });
    }

    if (route === "/products/count.json") return send(200, { count: products.length });

    if (route === "/products.json") {
      const limit = Math.min(250, Number(q.get("limit") || 50));
      const pageInfo = q.get("page_info");
      let start = pageInfo ? Number(pageInfo) * limit : 0;
      if (opts.repeatPage && start > 0) start = 0; // broken pagination: always returns page 1
      const slice = products.slice(start, start + limit);
      const more = start + limit < products.length;
      const headers = {};
      if (more && !opts.repeatPage) {
        const base = `http://${host}${PREFIX}`;
        headers.Link = `<${base}/products.json?limit=${limit}&page_info=${(start / limit) + 1}>; rel="next"`;
      }
      return send(200, { products: slice.map((p) => withHost(p, host)) }, headers);
    }

    const one = route.match(/^\/products\/(\d+)\.json$/);
    if (one) {
      const p = products.find((x) => String(x.id) === one[1]);
      if (!p) return send(404, { errors: "Not Found" });
      if (opts.slowStock) await new Promise((r) => setTimeout(r, 2400));
      return send(200, { product: withHost(p, host) });
    }

    if (route === "/products/search.json") {
      const term = (q.get("q") || "").toLowerCase();
      const found = products.filter((p) => p.title.toLowerCase().includes(term) || p.tags.toLowerCase().includes(term)).slice(0, Number(q.get("limit") || 10));
      return send(200, { products: found.map((p) => withHost(p, host)) });
    }

    if (route === "/locations.json") return send(200, { locations: LOCATIONS });
    const loc = route.match(/^\/locations\/(\d+)\.json$/);
    if (loc) {
      const l = LOCATIONS.find((x) => String(x.id) === loc[1]);
      return l ? send(200, { location: l }) : send(404, { errors: "Not Found" });
    }

    if (route === "/inventory_levels.json") {
      const itemIds = (q.get("inventory_item_ids") || "").split(",").filter(Boolean);
      const locationIds = (q.get("location_ids") || "").split(",").filter(Boolean);
      if (!itemIds.length && !locationIds.length) return send(422, { errors: { inventory_item_ids: ["or location_ids is required"] } });
      const levels = [];
      for (const p of products) {
        for (const v of p.variants) {
          if (itemIds.length && !itemIds.includes(String(v.inventory_item_id))) continue;
          for (const locId of locationIds.length ? locationIds : LOCATIONS.map((l) => String(l.id))) {
            const zoneStock = p._zoneStock[Number(locId)];
            levels.push({ inventory_item_id: v.inventory_item_id, location_id: Number(locId), available: zoneStock == null ? v.inventory_quantity : zoneStock, updated_at: p.updated_at });
          }
        }
      }
      return send(200, { inventory_levels: levels });
    }

    if (route === "/locations/resolve.json") {
      const area = (q.get("area") || "").toLowerCase();
      const matches = LOCATIONS.filter((l) => (l.x_chattrn.areas || []).some((a) => a.toLowerCase().includes(area) || area.includes(a.toLowerCase())))
        .map((l) => ({ location_id: l.id, name: l.name, confidence: 0.9 }));
      return send(200, { resolution: { query: q.get("area") || "", matches, serviceable: matches.length > 0 } });
    }

    if (route === "/delivery/rates.json") {
      return send(200, { delivery_rates: [{ code: "DHAKA-STD", title: "Inside Dhaka", price: "60.00", currency: "BDT", min_days: 1, max_days: 2, cod_available: true }] });
    }

    if (route === "/customers/search.json") {
      if (opts.ordersLocked) return send(403, { errors: "Forbidden" });
      const query = q.get("query") || "";
      const phone = query.startsWith("phone:") ? query.slice(6) : null;
      const email = query.startsWith("email:") ? query.slice(6) : null;
      const found = CUSTOMERS.filter((c) => (phone && c.phone === phone) || (email && c.email === email));
      return send(200, { customers: found });
    }

    const custOrders = route.match(/^\/customers\/(\d+)\/orders\.json$/);
    if (custOrders) {
      if (opts.ordersLocked) return send(403, { errors: "Forbidden" });
      const found = ORDERS.filter((o) => String(o.customer.id) === custOrders[1]);
      return send(200, { orders: found });
    }

    if (route === "/orders.json") {
      if (opts.ordersLocked) return send(401, { errors: "Unauthorized" });
      const name = q.get("name");
      const found = name ? ORDERS.filter((o) => o.name === name) : ORDERS;
      return send(200, { orders: found });
    }

    const order = route.match(/^\/orders\/(\d+)\.json$/);
    if (order) {
      if (opts.ordersLocked) return send(401, { errors: "Unauthorized" });
      const o = ORDERS.find((x) => String(x.id) === order[1]);
      return o ? send(200, { order: o }) : send(404, { errors: "Not Found" });
    }

    const fulfill = route.match(/^\/orders\/(\d+)\/fulfillments\.json$/);
    if (fulfill) {
      const o = ORDERS.find((x) => String(x.id) === fulfill[1]);
      return o ? send(200, { fulfillments: o.fulfillments || [] }) : send(404, { errors: "Not Found" });
    }

    if (route === "/draft_orders.json" && req.method === "POST") {
      if (opts.cartMissing) return send(404, { errors: "Not Found" });
      return send(201, { draft_order: { id: 990001, line_items: [], subtotal_price: "0.00", total_tax: "0.00", total_price: "0.00", currency: "BDT", shipping_line: { code: "DHAKA-STD", title: "Inside Dhaka", price: "60.00" }, status: "open" } });
    }
    const draftUpdate = route.match(/^\/draft_orders\/(\d+)\.json$/);
    if (draftUpdate && req.method === "PUT") {
      if (opts.cartMissing) return send(404, { errors: "Not Found" });
      let body = "";
      for await (const c of req) body += c;
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch { /* ignore */ }
      const items = (parsed.draft_order && parsed.draft_order.line_items) || [];
      const subtotal = items.reduce((s, li) => s + Number(li.price || 0) * Number(li.quantity || 1), 0);
      const total = subtotal + 60;
      return send(200, { draft_order: { id: Number(draftUpdate[1]), line_items: items, subtotal_price: subtotal.toFixed(2), total_tax: "0.00", total_price: total.toFixed(2), currency: "BDT", shipping_line: { code: "DHAKA-STD", title: "Inside Dhaka", price: "60.00" }, status: "open" } });
    }
    const draftComplete = route.match(/^\/draft_orders\/(\d+)\/complete\.json$/);
    if (draftComplete && req.method === "PUT") {
      if (opts.cartMissing) return send(404, { errors: "Not Found" });
      return send(200, { draft_order: { id: Number(draftComplete[1]), status: "completed", order_id: 5502 } });
    }
    const cancel = route.match(/^\/orders\/(\d+)\/cancel\.json$/);
    if (cancel && req.method === "POST") {
      const o = ORDERS.find((x) => String(x.id) === cancel[1]);
      if (!o) return send(404, { errors: "Not Found" });
      return send(200, { order: { ...o, cancelled_at: new Date().toISOString(), cancel_reason: "customer" } });
    }

    return send(404, { errors: "Not Found" });
  });

  return { server, requests, TOKEN, PREFIX };
}

function withHost(p, host) {
  const { _location, _zoneStock, ...rest } = p;
  return { ...rest, images: rest.images.map((i) => ({ ...i, src: i.src.replace("{host}", host) })) };
}

if (require.main === module) {
  const port = Number(process.env.MOCK_CHATTRN_PORT || 3102);
  createMockChattrnStore().server.listen(port, "127.0.0.1", () => {
    console.log(`Mock Chattrn API store on http://127.0.0.1:${port}${PREFIX}  (token: ${TOKEN})`);
  });
}

module.exports = { createMockChattrnStore, TOKEN, PREFIX };
