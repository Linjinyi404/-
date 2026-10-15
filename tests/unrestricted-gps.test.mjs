import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createHandler} from '../supabase/functions/attendance-api/handler.mjs';

test('upgrade removes geofencing while retaining GPS, history and authorization',async t=>{
 const db=new PGlite();
 try{
  await db.exec('create role anon;create role authenticated;create role service_role;');
  await db.exec(await readFile(new URL('../supabase/migrations/202610130001_attendance.sql',import.meta.url),'utf8'));
  const rpc=async(op,hash,payload={})=>(await db.query('select public.attendance_rpc($1,$2,$3::jsonb) result',[op,hash,JSON.stringify(payload)])).rows[0].result;
  const hash='a'.repeat(64),otherHash='b'.repeat(64);
  const worker=(await rpc('login',null,{lineSub:'U'+'1'.repeat(32),name:'測試員工',sessionHash:hash})).me;
  const other=(await rpc('login',null,{lineSub:'U'+'2'.repeat(32),name:'其他員工',sessionHash:otherHash})).me;
  const position={lat:-33.8688,lng:151.2093,accuracy:20,capturedAt:new Date().toISOString()};
  const payload=(key,pos=position)=>({type:'in',position:pos,key,fingerprint:key.padEnd(64,'0')});
  await assert.rejects(rpc('punch',hash,payload('before-upgrade')),/NO_LOCATIONS/);
  await db.query("insert into public.attendance_punches(employee_id,type,occurred_at,source,location_snapshot,position,distance_meters) values ($1,'in','2020-01-02T00:00:00Z','device','{\"name\":\"原有地點\"}',$2,120),($1,'out','2020-01-02T08:00:00Z','device','{\"name\":\"原有地點\"}',$2,130)",[worker.id,JSON.stringify(position)]);
  const before=(await db.query('select * from public.attendance_punches order by ordinal')).rows;
  await db.exec(await readFile(new URL('../supabase/migrations/202610150002_unrestricted_gps.sql',import.meta.url),'utf8'));
  await t.test('upgrade preserves existing rows and exposes their saved GPS',async()=>{
   assert.deepEqual((await db.query('select * from public.attendance_punches order by ordinal')).rows,before);
   const snap=await rpc('snapshot',hash,{from:'2020-01-02',to:'2020-01-02'});
   assert.equal(snap.attendancePolicy,'unrestricted_gps');assert.equal(snap.records.length,2);
   assert.equal(snap.records[0].locationName,'原有地點');assert.equal(snap.records[0].position.lat,position.lat);
  });
  await t.test('missing, invalid, stale, future and imprecise GPS still cannot punch',async()=>{
   for(const [pos,error] of [[null,/INVALID_INPUT/],[{...position,lat:91},/INVALID_INPUT/],[{...position,accuracy:151},/POSITION_UNCERTAIN/],[{...position,capturedAt:new Date(Date.now()-600000).toISOString()},/POSITION_STALE/],[{...position,capturedAt:new Date(Date.now()+120000).toISOString()},/POSITION_STALE/]])await assert.rejects(rpc('punch',hash,payload('rejected',pos)),error);
   assert.equal((await db.query('select count(*) n from public.attendance_punches')).rows[0].n,2);
  });
  const env={LINE_CHANNEL_ID:'1234',SUPABASE_URL:'https://testproject.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-only',ALLOWED_ORIGINS:'http://127.0.0.1:4175'};
  const handler=createHandler({env,fetcher:async(url,options)=>{
   if(url==='https://api.line.me/oauth2/v2.1/verify')return Response.json({iss:'https://access.line.me',aud:'1234',sub:'U'+'1'.repeat(32),name:'測試員工',exp:Math.floor(Date.now()/1000)+600});
   const b=JSON.parse(options.body);try{return Response.json(await rpc(b.p_op,b.p_session_hash,b.p_payload));}catch(e){return Response.json({message:e.message},{status:400});}
  }});
  let token,record,body;
  const req=async(path,method='GET',data,key)=>handler(new Request('https://testproject.supabase.co/functions/v1/attendance-api'+path,{method,headers:{Origin:env.ALLOWED_ORIGINS,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(key?{'Idempotency-Key':key}:{})},...(data?{body:JSON.stringify(data)}:{})}));
  await t.test('ordinary verified login and remote coordinates work with zero configured sites',async()=>{
   token=(await (await req('/session','POST',{idToken:'fixture-only-token-that-is-long-enough'})).json()).token;
   assert.equal((await db.query('select count(*) n from public.attendance_locations')).rows[0].n,0);
   body={type:'in',employeeId:other.id,timestamp:'1990-01-01',position:{...position,capturedAt:new Date().toISOString()}};
   const response=await req('/punches','POST',body,'far-away-fixture-key');assert.equal(response.status,200);record=await response.json();
   assert.equal(record.employeeId,worker.id);assert.equal(record.locationName,'不限範圍');assert.equal(record.distanceMeters,null);
   assert.equal(record.position.lat,position.lat);assert.equal(record.position.accuracy,20);assert.ok(Math.abs(Date.parse(record.timestamp)-Date.now())<5000);
  });
  await t.test('retry is idempotent after original fix becomes old; modified payload conflicts',async()=>{
   // A completed operation returns its saved result before GPS freshness checks.
   const original=await req('/punches','POST',body,'far-away-fixture-key');assert.equal((await original.json()).id,record.id);
   const raw=(await db.query('select idempotency_key key,fingerprint from public.attendance_punches where id=$1',[record.id])).rows[0];
   const saved=await rpc('punch',hash,{...raw,type:'in',position:{...position,capturedAt:'2020-01-01T00:00:00Z'}});assert.equal(saved.id,record.id);
   assert.equal((await req('/punches','POST',{...body,position:{...body.position,lat:0}},'far-away-fixture-key')).status,409);
   assert.equal((await req('/punches','POST',body,'duplicate-in-fixture')).status,409);
  });
  await t.test('export includes own GPS only, and valid clock-out changes shift state',async()=>{
   const today=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Taipei'});
   const exported=await (await req('/exports','POST',{from:today,to:today})).json();
   assert.equal(exported.attendancePolicy,'unrestricted_gps');assert.ok(exported.records.every(r=>r.employeeId===worker.id));assert.equal(exported.records[0].position.lat,position.lat);
   assert.equal((await rpc('snapshot',otherHash)).records.length,0);
   assert.equal((await req('/punches','POST',{type:'out',position:{...position,capturedAt:new Date().toISOString()}},'clock-out-fixture-key')).status,200);
   assert.equal((await (await req('/snapshot')).json()).currentShift,null);
  });
  await t.test('new wrapper remains service-only and legacy entry cannot bypass it',async()=>{
   for(const role of ['anon','authenticated','service_role']){
    await db.exec('set role '+role);
    await assert.rejects(db.query("select public.attendance_rpc_geofenced_v1('snapshot',$1,'{}')",[hash]),/permission denied/);
    if(role==='service_role')assert.equal((await rpc('snapshot',hash)).me.id,worker.id);else await assert.rejects(rpc('snapshot',hash),/permission denied/);
    await db.exec('reset role');
   }
   await assert.rejects(rpc('employee',hash,{id:worker.id,name:'測試員工',role:'admin',enabled:true}),/FORBIDDEN/);
  });
 }finally{await db.close();}
});
