"use strict";
// Finds the query parameter a store reads its zone from, by testing candidate names against a real zone.
// A name is accepted only when it changes the product list: the list is empty without it and not empty
// with it, or the list is different with it. Several names matching is reported, never guessed.
// Read-only: it only calls the store's product list and zone list.
const E = require("./endpoints");
const M = require("./mapping");

const CANDIDATES = ["zoneId", "zone_id", "zone", "zoneid", "zone-id", "area_id", "areaId", "location_id", "locationId"];

const idsOf = (list) => list.map((r) => String(M.idOf(r))).join(",");

async function discoverZoneParam(ctx, store, { host } = {}) {
  host = host || new URL(store.base_url).host;
  const z = await E.getJudged(ctx, store, "zones", {}, null, host);
  if (z.bad) return { state: "needs_attention", message: `Could not read the zone list to test with: ${z.bad.message}` };
  const zones = M.zonesOf(store, M.extractList(z.body) || []);
  if (!zones.length) return { state: "needs_attention", message: "The zone list is empty, so there is no zone to test with." };

  const zoneValue = String(zones[0].id);
  const path = E.fillPath(E.configOf(store, "products").path, { page: 1 });

  const base = await E.judgedPath(ctx, store, { path, useContext: false, host, label: "product list" });
  if (base.bad) return { state: "needs_attention", message: `Could not read the product list: ${base.bad.message}` };
  const baseList = M.extractList(base.body) || [];
  const baseIds = idsOf(baseList);

  const matched = [];
  for (const name of CANDIDATES) {
    const r = await E.judgedPath(ctx, store, { path, context: { name, value: zoneValue }, host, label: "product list" });
    if (r.bad) continue;
    const list = M.extractList(r.body) || [];
    if (!list.length) continue;
    if (!baseList.length || idsOf(list) !== baseIds) matched.push(name);
  }

  const probe = { zone_value: zoneValue, tried: CANDIDATES, matched, at: new Date().toISOString() };

  if (matched.length === 1) {
    store.delivery = { ...(store.delivery || {}), context_param: matched[0], param_confirmed: true, location_probe: probe };
    return {
      state: "passed",
      message: `This store reads the zone from ${matched[0]}. Checked with zone ${zoneValue}.`,
      matched,
    };
  }
  store.delivery = { ...(store.delivery || {}), location_probe: probe };
  if (matched.length > 1) {
    return {
      state: "needs_attention",
      message: `More than one name changes the product list: ${matched.join(", ")}. Confirm which one the store uses before saving.`,
      matched,
    };
  }
  return {
    state: "needs_attention",
    message: `No zone parameter found. Tried ${CANDIDATES.join(", ")}. None of them changed the product list.`,
    matched: [],
  };
}

module.exports = { discoverZoneParam, CANDIDATES };
