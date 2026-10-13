import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../supabase/functions/attendance-api/handler.mjs';
import {verifyLine,validatePunch,canonical,sha256} from '../supabase/functions/attendance-api/security.mjs';
const env={LINE_CHANNEL_ID:'1234',SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server-only',ALLOWED_ORIGINS:'https://team.github.io',BOOTSTRAP_LINE_SUB:'U'+'1'.repeat(32)};
const claims={iss:'https://access.line.me',aud:'1234',sub:'U'+'1'.repeat(32),exp:Math.floor(Date.now()/1000)+600,name:'哥'};
const request=(path,method='GET',body,headers={})=>new Request('https://project.supabase.co/functions/v1/attendance-api'+path,{method,headers:{Origin:'https://team.github.io',...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
test('LINE subject comes only from server verification, with audience, issuer and expiry checks',async()=>{
 const fetcher=async(url,options)=>{assert.equal(url,'https://api.line.me/oauth2/v2.1/verify');assert.equal(options.body.get('client_id'),'1234');return Response.json(claims);};
 assert.equal((await verifyLine('a'.repeat(30),'1234',fetcher)).sub,claims.sub);
 for(const bad of [{...claims,aud:'other'},{...claims,iss:'https://evil.test'},{...claims,exp:0},{...claims,sub:'claimed-user'}])await assert.rejects(verifyLine('a'.repeat(30),'1234',async()=>Response.json(bad)),/INVALID_LINE_TOKEN/);
 await assert.rejects(verifyLine('a'.repeat(30),'1234',async()=>new Response('',{status:400})),/INVALID_LINE_TOKEN/);
});
test('login ignores client role and identity and returns a hashed opaque session',async()=>{
 let input;
 const handler=createHandler({env,fetcher:async()=>Response.json(claims),rpc:async(op,hash,payload)=>{input={op,hash,payload};return{me:{id:'verified',role:'employee'}};}});
 const r=await handler(request('/session','POST',{idToken:'a'.repeat(30),role:'admin',userId:'fake'}));const body=await r.json();
 assert.equal(r.status,200);assert.equal(input.payload.lineSub,claims.sub);assert.equal(input.payload.name,'哥');assert.equal(input.payload.role,undefined);assert.equal(body.token.length,64);assert.equal(input.payload.sessionHash,await sha256(body.token));assert.notEqual(body.token,input.payload.sessionHash);
});
test('CORS, missing configuration and missing session block requests before database access',async()=>{
 let calls=0;const h=createHandler({env,rpc:async()=>{calls++;return{};}});
 assert.equal((await h(request('/snapshot','GET',null,{Origin:'https://evil.test'}))).status,403);
 assert.equal((await h(request('/snapshot'))).status,401);assert.equal(calls,0);
 const options=await h(request('/punches','OPTIONS'));assert.equal(options.status,204);assert.equal(options.headers.get('Access-Control-Allow-Origin'),'https://team.github.io');
 assert.equal((await createHandler({env:{...env,LINE_CHANNEL_ID:''}})(request('/session','POST',{idToken:'a'.repeat(30)}))).status,503);
});
test('punch strips claimed employee, role and time; retries retain request fingerprint',async()=>{
 const values=[];const h=createHandler({env,rpc:async(op,hash,payload)=>{values.push({op,hash,payload});return{id:'saved'};}});
 const body={type:'in',employeeId:'someone-else',role:'admin',timestamp:'1990-01-01',position:{lat:25,lng:121,accuracy:20,capturedAt:new Date().toISOString()}};
 const headers={Authorization:'Bearer '+'a'.repeat(64),'Idempotency-Key':'same-operation-key'};
 assert.equal((await h(request('/punches','POST',body,headers))).status,200);assert.equal((await h(request('/punches','POST',body,headers))).status,200);
 assert.equal(values[0].payload.employeeId,undefined);assert.equal(values[0].payload.timestamp,undefined);assert.equal(values[0].payload.fingerprint,values[1].payload.fingerprint);
});
test('invalid coordinates, keys and oversized inputs never reach trusted database RPC',async()=>{
 const h=createHandler({env,rpc:async()=>{throw new Error('must not run');}}),auth={Authorization:'Bearer '+'a'.repeat(64)};
 const p={type:'in',position:{lat:91,lng:121,accuracy:20,capturedAt:new Date().toISOString()}};
 assert.equal((await h(request('/punches','POST',p,{...auth,'Idempotency-Key':'valid-operation-key'}))).status,422);
 assert.equal((await h(request('/punches','POST',{...p,position:{...p.position,lat:25}},auth))).status,422);
 assert.equal((await h(request('/session','POST',{idToken:'a'.repeat(18000)}))).status,413);
 assert.throws(()=>validatePunch({type:'in',position:{lat:'25',lng:121,accuracy:20,capturedAt:new Date().toISOString()}}));
 assert.equal(canonical({b:2,a:1}),canonical({a:1,b:2}));
});
test('history and export validate real dates and preserve authenticated actor scope',async()=>{
 const calls=[];const h=createHandler({env,rpc:async(op,hash,payload)=>{calls.push({op,hash,payload});return{records:[]};}}),auth={Authorization:'Bearer '+'a'.repeat(64)};
 assert.equal((await h(request('/snapshot?from=2026-02-30&to=2026-03-01','GET',null,auth))).status,422);
 assert.equal((await h(request('/snapshot?from=2020-01-01&to=2026-01-01','GET',null,auth))).status,422);assert.equal(calls.length,0);
 assert.equal((await h(request('/exports','POST',{from:'2020-01-01',to:'2020-01-31',employeeId:'other',role:'admin'},auth))).status,200);assert.deepEqual(calls[0].payload,{from:'2020-01-01',to:'2020-01-31'});assert.equal(calls[0].op,'export');
});
test('modern Supabase secret keys use apikey without pretending to be a JWT',async()=>{
 let sent;const h=createHandler({env:{...env,SUPABASE_SERVICE_ROLE_KEY:'',SUPABASE_SECRET_KEYS:JSON.stringify({default:'sb_secret_test_only'})},fetcher:async(url,options)=>{sent=options;return Response.json({records:[]});}});
 assert.equal((await h(request('/snapshot','GET',null,{Authorization:'Bearer '+'a'.repeat(64)}))).status,200);assert.equal(sent.headers.apikey,'sb_secret_test_only');assert.equal(sent.headers.Authorization,undefined);
});
