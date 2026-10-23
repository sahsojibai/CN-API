"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const Flow=require('../public/setup-flow');
const {configurationStamp,activationProblem}=require('../src/onboarding');
const make=()=>({connection_type:'chattrn_api',chattrn:{base_url:'https://store.test/api',access_token_enc:'encrypted'},delivery:{mode:'outlet'},mapping:{},onboarding:{},test_runs:[]});
test('all adapters use Connect, Review, Verify, Activate with the same prerequisites',()=>{
 assert.deepEqual(Flow.steps.map(s=>s.title),['Connect','Review','Verify','Activate']);
 assert.equal(Flow.allowed(2,{}),false);assert.equal(Flow.allowed(3,{connected:true}),false);
 assert.equal(Flow.allowed(4,{connected:true,reviewed:true}),false);
 assert.equal(Flow.allowed(4,{connected:true,reviewed:true,verified:true}),true);
});
test('activation rejects missing, failing, expired and changed verification',()=>{
 const s=make();assert.match(activationProblem(s),/Review/);
 s.onboarding.review_stamp=configurationStamp(s);assert.match(activationProblem(s),/verification/);
 s.test_runs=[{can_continue:true,finished_at:new Date().toISOString(),configuration_stamp:configurationStamp(s)}];
 assert.equal(activationProblem(s),null);
 s.delivery.remember_area=true;assert.equal(activationProblem(s),null);
 s.chattrn.access_token_enc='changed';assert.match(activationProblem(s),/Review/);
 s.onboarding.review_stamp=configurationStamp(s);assert.match(activationProblem(s),/verification/);
 s.test_runs[0].configuration_stamp=configurationStamp(s);s.test_runs[0].finished_at=new Date(Date.now()-16*60000).toISOString();assert.match(activationProblem(s),/expired/);
});
test('configuration stamps survive JSON key reordering and ignore drafts',()=>{
 const a=make(),b=make();a.auth={mode:'key',header:'X-Key',secret_enc:'x'};b.auth={secret_enc:'x',header:'X-Key',mode:'key'};
 b.onboarding_draft={fields:{name:'new draft'}};assert.equal(configurationStamp(a),configurationStamp(b));
 b.endpoints={products:{path:'/changed'}};assert.notEqual(configurationStamp(a),configurationStamp(b));
});

test('endpoint diagnostics do not invalidate the reviewed configuration',()=>{
 const a=make(),b=make();a.endpoints={products:{method:'GET',path:'/products',added:true}};
 b.endpoints={products:{method:'GET',path:'/products',added:true,last_http:200,checked_at:new Date().toISOString()}};
 assert.equal(configurationStamp(a),configurationStamp(b));
 b.endpoints.products.path='/other';assert.notEqual(configurationStamp(a),configurationStamp(b));
});
