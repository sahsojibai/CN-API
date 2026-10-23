"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),http=require("node:http"),zlib=require("node:zlib");
const {request,throttle,MAX_BYTES,isPrivateIp}=require("../src/http");
test("DNS is resolved once and only the validated address reaches the connection",async()=>{
 const server=http.createServer((req,res)=>res.end('{"ok":true}'));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let lookups=0, pinned;
 try {
  const result=await request({url:'https://merchant.test/api'}, {
   lookup:async()=>{lookups++;return [{address:lookups===1?'8.8.8.8':'127.0.0.1',family:4}];},
   transport:{request(url,options,callback){ options.lookup('merchant.test',{all:true},(err,addresses)=>{assert.ifError(err);pinned=addresses;}); return http.request(`http://127.0.0.1:${server.address().port}/`,{method:options.method,signal:options.signal},callback);}}
  });
  assert.equal(result.json.ok,true);assert.equal(lookups,1);assert.deepEqual(pinned,[{address:'8.8.8.8',family:4}]);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test("mixed public/private DNS is rejected before any connection",async()=>{
 let connected=false;
 const result=await request({url:'https://merchant.test'}, {lookup:async()=>[{address:'8.8.8.8'},{address:'127.0.0.1'}],transport:{request(){connected=true;}}});
 assert.equal(result.error,'refused');assert.equal(connected,false);
});
test("DNS resolution shares the overall request deadline",async()=>{
 const began=Date.now();const result=await request({url:'https://merchant.test',timeoutMs:30},{lookup:()=>new Promise(()=>{})});
 assert.equal(result.error,'timeout');assert.ok(Date.now()-began<500);
});
test("chunked and decompressed bodies are limited while streaming; redirects are not followed",async()=>{
 process.env.ALLOW_PRIVATE_HOSTS='1';
 const huge=Buffer.alloc(MAX_BYTES+1000,'a');let targetCalls=0;
 const server=http.createServer((req,res)=>{
  if(req.url==='/target'){targetCalls++;return res.end('should not be called');}
  if(req.url==='/redirect'){res.writeHead(302,{Location:'/target'});return res.end();}
  if(req.url==='/gzip'){res.writeHead(200,{'Content-Encoding':'gzip'});return res.end(zlib.gzipSync(huge));}
  if(req.url==='/slow'){res.writeHead(200);res.write('start');return;}
  res.writeHead(200);for(let i=0;i<huge.length;i+=32768)res.write(huge.subarray(i,i+32768));res.end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  assert.equal((await request({url:base+'/chunked'})).error,'too_large');
  assert.equal((await request({url:base+'/gzip'})).error,'too_large');
  assert.equal((await request({url:base+'/redirect'})).error,'redirect');assert.equal(targetCalls,0);
  assert.equal((await request({url:base+'/slow',timeoutMs:30})).error,'timeout');
 }finally{delete process.env.ALLOW_PRIVATE_HOSTS;server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test("simultaneous throttle calls keep their spacing and different stores are independent",async()=>{
 const times=[];await Promise.all(Array.from({length:8},()=>throttle('same',15).then(()=>times.push(Date.now()))));
 assert.ok(times[7]-times[0]>=98,JSON.stringify(times));
 const start=Date.now();await Promise.all([throttle('one',100),throttle('two',100)]);assert.ok(Date.now()-start<90);
});
test("reserved IPv6 and documentation destinations are refused",()=>{
 for(const ip of ['192.0.2.1','198.51.100.2','203.0.113.1','2001:db8::1','2002:7f00:1::','64:ff9b::7f00:1','3fff::1'])assert.equal(isPrivateIp(ip),true,ip);
 assert.equal(isPrivateIp('2606:4700:4700::1111'),false);
});

test("routing and framing authentication headers are rejected",async()=>{
 for(const header of ['Host','Transfer-Encoding','Content-Length','X-Forwarded-Host']){
  const result=await request({url:'https://merchant.test',headers:{[header]:'untrusted'}});
  assert.equal(result.error,'refused');
 }
});
