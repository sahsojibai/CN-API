"use strict";
const dns = require("node:dns").promises;
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const zlib = require("node:zlib");
const { Transform, Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const MAX_BYTES = 2 * 1024 * 1024;
class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function allowPrivate() { return process.env.ALLOW_PRIVATE_HOSTS === "1" && !process.env.RENDER && process.env.NODE_ENV !== "production"; }
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a,b,c] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113);
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return net.isIPv4(v.slice(7)) ? isPrivateIp(v.slice(7)) : true;
    const [first, second] = v.split(":").map(x => parseInt(x || "0",16));
    // Only global unicast, excluding documentation, transition and special-purpose space.
    return first < 0x2000 || first > 0x3fff || first === 0x2002 ||
      (first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) || first === 0x3fff;
  }
  return true;
}
function parseUrl(raw) {
  let u; try { u = new URL(raw); } catch { throw new HttpError(400,"bad_url","That address isn't a valid URL."); }
  if (!(u.protocol === "https:" || (allowPrivate() && u.protocol === "http:"))) throw new HttpError(400,"not_https","Use an HTTPS address.");
  if (u.username || u.password) throw new HttpError(400,"credentials_in_url","Remove the username and password from the address.");
  return u;
}
async function resolveTarget(raw, lookup = dns.lookup.bind(dns)) {
  const u = parseUrl(raw), host = u.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  try { addresses = net.isIP(host) ? [{address:host,family:net.isIP(host)}] : await lookup(host,{all:true}); }
  catch { throw new HttpError(502,"dns","DNS lookup failed. Check the website address."); }
  if (!addresses?.length || addresses.some(a => !net.isIP(a.address) || (!allowPrivate() && isPrivateIp(a.address)))) throw new HttpError(400,"private_address","That address is not a public network destination.");
  return { u, addresses: addresses.map(a => ({address:a.address,family:net.isIP(a.address)})) };
}
async function assertPublicUrl(raw) {
  if (allowPrivate()) return parseUrl(raw);
  return (await resolveTarget(raw)).u;
}
function byteLimit() {
  let size = 0;
  return new Transform({transform(chunk,encoding,callback) {
    size += chunk.length;
    callback(size > MAX_BYTES ? new HttpError(502,"too_large","Response exceeds 2 MB.") : null, size > MAX_BYTES ? undefined : chunk);
  }});
}
// Dependencies are injectable for tests; callers cannot supply them through API request bodies.
async function request({url,method="GET",headers={},body,timeoutMs=10000}, dependencies = {}) {
  const started = performance.now(), elapsed = () => Math.round(performance.now()-started);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, Math.min(60000, timeoutMs)));
  let abortListener;
  try {
    if (Object.keys(headers).some(key => /^(host|connection|proxy-authorization|proxy-connection|transfer-encoding|content-length|upgrade|expect|te|trailer|forwarded|x-forwarded-.+|x-real-ip)$/i.test(key))) throw new HttpError(400,"unsafe_header","Routing and hop-by-hop headers cannot be used for API authentication.");
    const interrupted = new Promise((resolve,reject) => { abortListener = () => reject(Object.assign(new Error("Timed out"),{name:"AbortError"})); ctrl.signal.addEventListener("abort",abortListener,{once:true}); });
    const {u,addresses} = await Promise.race([resolveTarget(url,dependencies.lookup),interrupted]);
    ctrl.signal.removeEventListener("abort",abortListener);
    // The actual socket resolves from this immutable validated set, never a second DNS lookup.
    const pinnedLookup = (_host,options,callback) => {
      const available = options?.family ? addresses.filter(a=>a.family===options.family) : addresses;
      if (!available.length) return callback(Object.assign(new Error("No validated address for family"),{code:"ENOTFOUND"}));
      if (options?.all) callback(null,available); else callback(null,available[0].address,available[0].family);
    };
    const transport = dependencies.transport || (u.protocol === "https:" ? https : http);
    return await new Promise((resolve,reject) => {
      const req = transport.request(u,{method,headers:{"Accept-Encoding":"identity",...headers},lookup:pinnedLookup,signal:ctrl.signal},async res => {
        const base = {http:res.statusCode,ms:elapsed(),isJson:false,text:""};
        if (res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); return resolve({...base,error:"redirect"}); }
        if (method !== "HEAD" && Number(res.headers["content-length"] || 0) > MAX_BYTES) { res.destroy(); return resolve({...base,error:"too_large"}); }
        try {
          const chunks = [];
          const stages = [res,byteLimit()];
          const encoding = method === "HEAD" || res.statusCode === 204 ? "identity" : String(res.headers["content-encoding"] || "identity").toLowerCase();
          if (encoding === "gzip") stages.push(zlib.createGunzip());
          else if (encoding === "deflate") stages.push(zlib.createInflate());
          else if (encoding === "br") stages.push(zlib.createBrotliDecompress());
          else if (encoding !== "identity") throw new HttpError(502,"encoding","Unsupported response encoding.");
          stages.push(byteLimit(),new Writable({write(chunk,encoding,callback){chunks.push(chunk);callback();}}));
          await pipeline(...stages,{signal:ctrl.signal});
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null, isJson = false; try { json = JSON.parse(text); isJson = true; } catch {}
          resolve({http:res.statusCode,ms:elapsed(),json,isJson,empty:!text.length,text:text.slice(0,2000),
            retryAfter:res.headers["retry-after"],link:res.headers.link,setCookie:res.headers["set-cookie"] || []});
        } catch(error) {
          res.destroy();
          if (error.code === "too_large") resolve({...base,ms:elapsed(),error:"too_large"});
          else reject(error);
        }
      });
      req.on("error",reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  } catch (error) {
    if (ctrl.signal.aborted || error.name === "AbortError") return {http:null,ms:elapsed(),error:"timeout"};
    if (error instanceof HttpError) return {http:null,ms:elapsed(),error:"refused",message:error.message};
    return {http:null,ms:elapsed(),error:"network",reason:error.code || "connection_failed"};
  } finally { clearTimeout(timer); if (abortListener) ctrl.signal.removeEventListener("abort",abortListener); }
}
const queues = new Map();
async function throttle(key,gapMs=200) {
  let entry = queues.get(key);
  if (!entry) { entry={tail:Promise.resolve(),last:0,pending:0,timer:null}; queues.set(key,entry); }
  clearTimeout(entry.timer);
  if (entry.pending >= 1000) throw new HttpError(429,"queue_full","Too many pending requests for this store.");
  entry.pending++;
  const run = entry.tail.then(async()=>{
    const wait = entry.last + gapMs - Date.now();
    if (wait > 0) await new Promise(resolve=>setTimeout(resolve,wait));
    entry.last = Date.now();
  });
  entry.tail = run.catch(()=>{});
  try { await run; } finally {
    entry.pending--;
    if (!entry.pending) { entry.timer=setTimeout(()=>{if(!entry.pending && queues.get(key)===entry)queues.delete(key);},Math.max(1,gapMs)); entry.timer.unref?.(); }
  }
}
module.exports = {HttpError,request,throttle,assertPublicUrl,isPrivateIp,MAX_BYTES};
