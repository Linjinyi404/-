// Local-only UI fixtures: no real LINE accounts, location or remote writes.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createHandler} from '../supabase/functions/attendance-api/handler.mjs';
const port=4175,origin=`http://127.0.0.1:${port}`,db=new PGlite();
await db.exec('create role anon;create role authenticated;create role service_role;');
for(const file of ['202610130001_attendance.sql','202610150002_unrestricted_gps.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
const env={LINE_CHANNEL_ID:'1234',SUPABASE_URL:'https://testproject.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-only',ALLOWED_ORIGINS:origin};
const handler=createHandler({env,fetcher:async(url,options)=>{
 if(url==='https://api.line.me/oauth2/v2.1/verify')return Response.json({iss:'https://access.line.me',aud:'1234',sub:'U'+'2'.repeat(32),exp:Math.floor(Date.now()/1000)+600,name:'測試員工'});
 const b=JSON.parse(options.body);try{return Response.json((await db.query('select public.attendance_rpc($1,$2,$3::jsonb) result',[b.p_op,b.p_session_hash,JSON.stringify(b.p_payload)])).rows[0].result);}catch(e){return Response.json({message:e.message},{status:400});}
}});
const root=resolve(fileURLToPath(new URL('../frontend/',import.meta.url)));
const fixture=`<aside style="padding:8px;background:#fff4d6;position:relative;z-index:4">本機虛構帳號／GPS 測試 <label>定位情境 <select id="qa-gps"><option value="far">雪梨座標</option><option value="deny">拒絕定位</option><option value="poor">精度不足</option></select></label></aside><script>
globalThis.liff={init:async()=>{},isLoggedIn:()=>true,getIDToken:()=> 'fixture-only-token-that-is-long-enough',logout:()=>{}};
const realFetch=globalThis.fetch;globalThis.fetch=(url,options)=>realFetch(String(url).replace('https://testproject.supabase.co',''),options);
Object.defineProperty(navigator,'geolocation',{value:{getCurrentPosition(ok,fail){const mode=document.querySelector('#qa-gps').value;if(mode==='deny')return fail({code:1});ok({coords:{latitude:-33.8688,longitude:151.2093,accuracy:mode==='poor'?200:20},timestamp:Date.now()});}}});
</script>`;
http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,origin);
  if(url.pathname.startsWith('/functions/v1/attendance-api')){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const response=await handler(new Request(origin+req.url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})}));
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
  }
  if(url.pathname==='/qa-status'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({punches:(await db.query('select type,position from public.attendance_punches order by ordinal')).rows,sites:(await db.query('select count(*) n from public.attendance_locations')).rows[0].n}));return;}
  let path=resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));if(!path.startsWith(root+sep)&&path!==resolve(root,'index.html')){res.writeHead(403);res.end();return;}
  let body=await readFile(path);if(path.endsWith('index.html'))body=Buffer.from(body.toString().replace('<body>','<body>'+fixture));
  if(path.endsWith('config.js'))body=Buffer.from("export const config={liffId:'test-liff',apiUrl:'https://testproject.supabase.co/functions/v1/attendance-api',companyName:'到班'};");
  res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css'})[extname(path)]||'application/octet-stream','Cache-Control':'no-store'});res.end(body);
 }catch{res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log('GPS fixture UI: '+origin+' (no remote writes)'));
