"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp, createConfiguredApp } = require("../src/server");
const { createAdminAuth } = require("../src/admin-auth");

const TOKEN = "test-admin-token-long-and-private";
test("dashboard sign-in protects API calls, rejects cross-origin changes and supports logout", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cnapi-auth-"));
  const app = createApp({ dataDir, publicDir: path.join(__dirname, "../public"), adminToken: TOKEN });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (route, { method = "GET", headers = {}, body } = {}) => fetch(base + route, { method, headers, body: body && JSON.stringify(body) });
  const loginHeaders = { "Content-Type": "application/json", "X-Chattrn-Request": "dashboard" };
  try {
    assert.equal((await request("/api/stores")).status, 401);
    assert.equal((await request("/health")).status, 200);
    assert.deepEqual(await (await request("/auth/session")).json(), { required: true, authenticated: false });
    assert.equal((await request("/auth/login", { method: "POST", headers: loginHeaders, body: { token: "wrong" } })).status, 401);
    assert.equal((await request("/auth/login", { method: "POST", headers: { ...loginHeaders, Origin: "https://evil.test" }, body: { token: TOKEN } })).status, 403);
    assert.equal((await request("/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: { token: TOKEN } })).status, 403);
    const login = await request("/auth/login", { method: "POST", headers: loginHeaders, body: { token: TOKEN } });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.ok(!cookie.includes(TOKEN));
    const cookieHeader = cookie.split(";")[0];
    assert.equal((await request("/api/stores", { headers: { Cookie: cookieHeader } })).status, 200);
    assert.equal((await request("/api/stores", { headers: { "X-Admin-Token": TOKEN } })).status, 200);
    const tampered = cookieHeader.slice(0, -5) + "wrong";
    assert.equal((await request("/api/stores", { headers: { Cookie: tampered } })).status, 401);
    assert.equal((await request("/api/stores/unknown/disconnect", { method: "POST", headers: { Cookie: cookieHeader, "Content-Type": "application/json" }, body: {} })).status, 403);
    assert.equal((await request("/api/stores/unknown/disconnect", { method: "POST", headers: { ...loginHeaders, Cookie: cookieHeader, Origin: "https://evil.test" }, body: {} })).status, 403);
    // Cookie-authenticated request reaches the route when the dashboard header is present.
    assert.equal((await request("/api/stores/unknown/disconnect", { method: "POST", headers: { ...loginHeaders, Cookie: cookieHeader }, body: {} })).status, 404);
    const logout = await request("/auth/logout", { method: "POST", headers: { ...loginHeaders, Cookie: cookieHeader }, body: {} });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
    for (let i = 0; i < 19; i++) await request("/auth/login", { method: "POST", headers: loginHeaders, body: { token: "wrong" } });
    assert.equal((await request("/auth/login", { method: "POST", headers: loginHeaders, body: { token: "wrong" } })).status, 429);
  } finally {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("session cookies expire and are invalidated by rotating the admin token", () => {
  const auth = createAdminAuth(TOKEN, true);
  const cookie = auth.issue();
  assert.match(cookie, /; Secure/);
  const req = { headers: { cookie: cookie.split(";")[0] } };
  assert.equal(auth.sessionValid(req), true);
  assert.equal(createAdminAuth("new-admin-token").sessionValid(req), false);
  const now = Date.now;
  try {
    Date.now = () => now() + 3601000;
    assert.equal(auth.sessionValid(req), false);
  } finally { Date.now = now; }
});

test("Render startup requires dashboard authentication", async () => {
  const previous = process.env.RENDER;
  process.env.RENDER = "true";
  try {
    await assert.rejects(createConfiguredApp({}), /requires ADMIN_TOKEN/);
  } finally {
    if (previous === undefined) delete process.env.RENDER;
    else process.env.RENDER = previous;
  }
});
