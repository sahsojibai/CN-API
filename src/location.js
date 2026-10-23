"use strict";
// Automatic diagnostic discovery. Its sample location is never a customer/store default.
const E = require("./endpoints");
const M = require("./mapping");
const CANDIDATES = ["zoneId", "zone_id", "zone", "zoneid", "zone-id", "area_id", "areaId", "location_id", "locationId", "outlet_id", "outletId", "branch_id", "branchId"];
const idsOf = list => list.map(row => String(M.idOf(row))).join(",");

async function discoverZoneParam(ctx, store, { host } = {}) {
  host = host || new URL(store.base_url).host;
  const result = await E.getJudged(ctx, store, "zones", {}, null, host);
  if (result.bad) return {state:"needs_attention",message:`Could not read locations: ${result.bad.message}`};
  const zones = M.zonesOf(store,M.extractList(result.body)||[]);
  if (!zones.length) return {state:"needs_attention",message:"No locations were exposed by the location endpoint."};
  const path = E.fillPath(E.configOf(store,"products").path,{page:1});
  const base = await E.judgedPath(ctx,store,{path,useContext:false,host,label:"product list"});
  if (base.bad && ![400,422].includes(base.res.http)) return {state:"needs_attention",message:base.bad.message};
  const baseList = M.extractList(base.body)||[];
  const signature = zones.map(zone=>String(zone.id)).join(",");
  const previous = store.delivery?.location_probe;
  const resume = previous?.pending && previous.signature === signature;
  let zoneIndex = resume ? previous.zone_index : 0;
  let candidateIndex = resume ? previous.candidate_index : 0;
  let matched = resume ? previous.matched : [];
  const deadline = Date.now()+20000;
  for (;zoneIndex<zones.length;zoneIndex++) {
    const zoneValue = String(zones[zoneIndex].id);
    for (;candidateIndex<CANDIDATES.length;candidateIndex++) {
      if (Date.now()>deadline) {
        store.delivery = {...store.delivery,location_probe:{pending:true,signature,zone_index:zoneIndex,candidate_index:candidateIndex,matched}};
        return {state:"pending",retryable:true,message:`Automatic discovery is continuing across all ${zones.length} locations (${zoneIndex} checked). No location selection is needed.`};
      }
      const name = CANDIDATES[candidateIndex];
      const read = await E.judgedPath(ctx,store,{path,context:{name,value:zoneValue},host,label:"product list"});
      const list = read.bad ? [] : M.extractList(read.body)||[];
      if (list.length && (!baseList.length || idsOf(list)!==idsOf(baseList))) matched.push(name);
    }
    if (matched.length || baseList.length) {
      const probe = {zone_value:zoneValue,tried:CANDIDATES,matched,at:new Date().toISOString(),pending:false};
      if (matched.length===1) {
        store.delivery = {...store.delivery,context_param:matched[0],param_confirmed:true,location_probe:probe,sample_location_id:zoneValue};
        return {state:"passed",message:`Discovered ${matched[0]} automatically. Sampling location ${zoneValue} does not restrict the full-store import.`,matched};
      }
      store.delivery = {...store.delivery,location_probe:probe};
      return {state:"needs_attention",message:matched.length>1 ? `Several location parameters match: ${matched.join(", ")}. Confirm the API parameter mapping.` : `No zone parameter found. Tried ${CANDIDATES.join(", ")}. Global products remain available.`,matched};
    }
    candidateIndex=0;matched=[];
  }
  store.delivery = {...store.delivery,location_probe:{pending:false,tried:CANDIDATES,matched:[],at:new Date().toISOString()}};
  return {state:"needs_attention",message:`No product samples were found across ${zones.length} locations. Check the API's product and location parameter mappings.`,matched:[]};
}
module.exports = {discoverZoneParam,CANDIDATES};
