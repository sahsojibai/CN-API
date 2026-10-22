"use strict";
// A local stand-in for a store's own API, with sample field names (sellPrice, comparePrice,
// totalStock, inStock, zoneId). Use it to test the flow without the real store.
//   node src/mock-store.js          -> http://127.0.0.1:3101/api/shop
// Key: every call except images needs the header X-API-Key: mock-key-1234567890
//
// Options (tests use these):
//   zoneRequired: true   products return 200 with an empty list unless the zone parameter is sent
//   paging: "page" | "link" | "cursor" | "offset"   how the product list pages
//   zoneParam: "zoneId" (default) | any name   the query parameter that filters products by zone
const http = require("node:http");

const KEY = "mock-key-1234567890";
const PREFIX = "/api/shop";
const PAGE_SIZE = 20;
const ZONES = Array.from({ length: 48 }, (_, i) => ({ zoneId: 100 + i, zoneName: `Zone ${i + 1}` }));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

function makeProducts() {
  return Array.from({ length: 600 }, (_, i) => {
    const id = 5000 + i;
    const stock = i % 11 === 0 ? 0 : (i * 7) % 50;
    const p = {
      productId: id,
      productName: `Test Item ${i + 1} rice`,
      sellPrice: (100 + ((i % 40) * 10)).toFixed(2),
      comparePrice: i % 4 === 0 ? (150 + ((i % 40) * 10)).toFixed(2) : null,
      totalStock: stock,
      inStock: stock > 0,
      zoneId: ZONES[i % 48].zoneId,
      brand: "MockBrand",
      _imagePath: `/img/${id}.png`,
    };
    if (i % 3 === 0) {
      p.variants = [
        { variantId: id * 10 + 1, optionValue: "Red", sellPrice: p.sellPrice, stockQty: stock },
        { variantId: id * 10 + 2, optionValue: "Blue", sellPrice: p.sellPrice, stockQty: Math.floor(stock / 2) },
      ];
    }
    return p;
  });
}

function toApi(p, host) {
  const { _imagePath, ...rest } = p;
  return { ...rest, images: [`http://${host}${_imagePath}`] };
}

const ORDERS = {
  "01700000000": [
    { id: 1001, orderNumber: "ORD-1001", status: "shipped", totalPrice: "450.00", currency: "BDT", customer: { customerId: 77, phone: "01700000000", firstName: "Test" } },
    { id: 1002, orderNumber: "ORD-1002", status: "processing", totalPrice: "120.00", currency: "BDT", customer: { customerId: 77, phone: "01700000000", firstName: "Test" } },
  ],
};

function createMockServer(opts = {}) {
  const { zoneRequired = false, paging = "page", zoneParam = "zoneId" } = opts;
  const products = makeProducts();
  const requests = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push({ method: req.method, path: url.pathname, search: url.search });
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };

    if (url.pathname.startsWith("/img/")) {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": PNG.length });
      return res.end(req.method === "HEAD" ? undefined : PNG);
    }
    if (!url.pathname.startsWith(PREFIX)) return send(404, { errors: { path: ["not found"] } });
    if (req.headers["x-api-key"] !== KEY) return send(401, { errors: "Invalid API key" });
    if (req.method !== "GET") return send(405, { errors: "This mock is read-only" });

    const route = url.pathname.slice(PREFIX.length) || "/";
    const host = req.headers.host;
    const base = `http://${host}${PREFIX}`;

    if (route === "/products") {
      const zone = url.searchParams.get(zoneParam);
      if (zoneRequired && !zone) return send(200, { products: [], page: 1, total_pages: 0 });
      const list = zone ? products.filter((p) => String(p.zoneId) === zone) : products;
      let start;
      let page;
      if (paging === "offset") {
        start = Number(url.searchParams.get("offset") || 0);
        page = Math.floor(start / PAGE_SIZE) + 1;
      } else {
        page = Math.max(1, Number(url.searchParams.get("cursor") || url.searchParams.get("page") || 1));
        start = (page - 1) * PAGE_SIZE;
      }
      const slice = list.slice(start, start + PAGE_SIZE);
      const more = start + PAGE_SIZE < list.length;
      const body = { products: slice.map((p) => toApi(p, host)), page, total_pages: Math.ceil(list.length / PAGE_SIZE) };
      const headers = {};
      if (paging === "link" && more) headers.Link = `<${base}/products?page=${page + 1}>; rel="next"`;
      if (paging === "cursor") body.next_cursor = more ? String(page + 1) : null;
      return send(200, body, headers);
    }
    const one = route.match(/^\/products\/(\d+)$/);
    if (one) {
      const p = products.find((x) => String(x.productId) === one[1]);
      return p ? send(200, { product: toApi(p, host) }) : send(404, { errors: { product: ["not found"] } });
    }
    if (route === "/search") {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      const found = products.filter((p) => p.productName.toLowerCase().includes(q)).slice(0, 20);
      return send(200, { products: found.map((p) => toApi(p, host)) });
    }
    if (route === "/delivery-zone") return send(200, { zones: ZONES });
    if (route === "/payment-methods") {
      return send(200, { payment_methods: [
        { code: "cod", name: "Cash on delivery" },
        { code: "bkash", name: "bKash" },
        { code: "card", name: "Card" },
        { code: "bank", name: "Bank transfer" },
      ] });
    }
    if (route === "/brand") return send(200, { brand: { name: "Mock Store" } });
    if (route === "/orders") {
      const phone = url.searchParams.get("phone");
      return send(200, { orders: ORDERS[phone] || [] });
    }
    const order = route.match(/^\/orders\/([^/]+)$/);
    if (order) {
      const found = Object.values(ORDERS).flat().find((o) => o.orderNumber === order[1]);
      if (!found) return send(404, { errors: { order: ["not found"] } });
      return send(200, { order: { orderNumber: found.orderNumber, status: found.status, items: [{ name: "Test Item 1 rice", quantity: 1 }] } });
    }
    return send(404, { errors: { route: ["unknown"] } });
  });

  return { server, requests };
}

if (require.main === module) {
  const port = Number(process.env.MOCK_PORT || 3101);
  createMockServer().server.listen(port, "127.0.0.1", () => {
    console.log(`Mock store on http://127.0.0.1:${port}${PREFIX}  (key: ${KEY})`);
  });
}

module.exports = { createMockServer, KEY, PREFIX };
