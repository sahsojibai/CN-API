"use strict";
process.env.ALLOW_PRIVATE_HOSTS = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const { sniffFramework } = require("../src/framework-sniff");

test("package discovery wins over absent homepage fingerprints without sending auth", async () => {
  const calls = [];
  const found = await sniffFramework("https://store.test/", async opts => {
    calls.push(opts); return { http: 200, json: { package: "chattrn/connector", framework: "Laravel", api_path: "/custom/api", package_version: "1.2.2" } };
  });
  assert.equal(found.package_status, "installed"); assert.equal(found.laravel_likely, true);
  assert.equal(found.api_path, "/custom/api"); assert.equal(calls.length, 1);
  assert.equal(calls[0].headers, undefined);
  assert.equal(calls[0].url, "https://store.test/.well-known/chattrn.json");
});
test("sleeping stores are unavailable, unknown pages are not declared non-Laravel", async () => {
  const sleeping = await sniffFramework("https://store.test", async () => ({ http: 503 }));
  assert.equal(sleeping.package_status, "unavailable"); assert.equal(sleeping.laravel_likely, null);
  const unknown = await sniffFramework("https://store.test", async opts => opts.url.includes("well-known") ? { http: 404 } : { http: 200, text: "Custom shop", setCookie: [] });
  assert.equal(unknown.laravel_likely, null); assert.equal(unknown.package_status, "not_found");
  const laravel = await sniffFramework("https://store.test", async opts => opts.url.includes("well-known") ? { http: 404 } : { http: 200, setCookie: ["custom_XSRF-TOKEN=yes"] });
  assert.equal(laravel.laravel_likely, true);
});
test("discovery rejects external API paths and treats login pages as inconclusive", async () => {
  const result = await sniffFramework("https://store.test", async opts => opts.url.includes("well-known") ? { http: 200, json: { package: "chattrn/connector", framework: "Laravel", api_path: "//evil.test/api" } } : { http: 401, text: "Sign in" });
  assert.notEqual(result.package_status, "installed"); assert.equal(result.laravel_likely, null);
});

test("disabled catalog imports never poll the database, including explicit wakes", async () => {
  const previous = process.env.CHATTRN_CATALOG_IMPORTS_ENABLED;
  process.env.CHATTRN_CATALOG_IMPORTS_ENABLED = 'false';
  let polls = 0;
  const jobs = require('../src/catalog-jobs').createCatalogJobs({db:{pendingCatalogJobs:async()=>{polls++;return [];}}});
  try {
    assert.equal(jobs.enabled,false);
    jobs.start(); jobs.wake();
    await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(polls,0);
  } finally {
    jobs.stop();
    if(previous===undefined) delete process.env.CHATTRN_CATALOG_IMPORTS_ENABLED;
    else process.env.CHATTRN_CATALOG_IMPORTS_ENABLED=previous;
  }
});
