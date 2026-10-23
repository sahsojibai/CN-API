"use strict";
// Runs without ALLOW_PRIVATE_HOSTS: the safety rules must be on.
const test = require("node:test");
const assert = require("node:assert/strict");
const { assertPublicUrl, isPrivateIp } = require("../src/http");

test("private and reserved IPv4 ranges are refused", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.0.1", "172.31.255.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "203.0.113.5"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "172.32.0.1", "100.63.0.1"]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test("IPv6 loopback, ULA and link-local are refused", () => {
  for (const ip of ["::1", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1"]) assert.equal(isPrivateIp(ip), true, ip);
});

test("a private IP literal is refused for a public https address", async () => {
  await assert.rejects(() => assertPublicUrl("https://127.0.0.1/api"), { code: "private_address" });
  await assert.rejects(() => assertPublicUrl("https://10.0.0.5/api"), { code: "private_address" });
});

test("plain http and credentials in the URL are refused", async () => {
  await assert.rejects(() => assertPublicUrl("http://example.com/api"), { code: "not_https" });
  await assert.rejects(() => assertPublicUrl("https://user:pass@example.com/api"), { code: "credentials_in_url" });
});
