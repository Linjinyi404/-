import { ApiError, sha256, randomToken, canonical, validatePunch, verifyLine, readJson, sessionHash } from './security.mjs';

const statuses={UNAUTHENTICATED:401,ACCOUNT_DISABLED:403,FORBIDDEN:403,SELF_REVIEW_FORBIDDEN:403,LAST_ADMIN:409,PUNCH_STATE_CONFLICT:409,IDEMPOTENCY_CONFLICT:409,ALREADY_REVIEWED:409,SEQUENCE_CONFLICT:409,NOT_FOUND:404};
export function createHandler({env,fetcher=fetch,rpc:injectedRpc}) {
  const origins=(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
  let managedSecret='';try{managedSecret=JSON.parse(env.SUPABASE_SECRET_KEYS||'{}').default||'';}catch{}
  const databaseKey=env.DATABASE_SECRET_KEY||managedSecret||env.SUPABASE_SERVICE_ROLE_KEY;
  const configured=Boolean(env.LINE_CHANNEL_ID&&env.SUPABASE_URL&&typeof databaseKey==='string'&&databaseKey&&origins.length);
  const rpc=injectedRpc||async function(op,hash,payload={}){
    let r;
    try{r=await fetcher(`${env.SUPABASE_URL.replace(/\/$/,'')}/rest/v1/rpc/attendance_rpc`,{method:'POST',headers:{apikey:databaseKey,...(databaseKey.startsWith('sb_secret_')?{}:{Authorization:`Bearer ${databaseKey}`}),'Content-Type':'application/json'},body:JSON.stringify({p_op:op,p_session_hash:hash,p_payload:payload}),signal:AbortSignal.timeout(15000)});}catch{throw new ApiError('DATABASE_UNAVAILABLE',503);}
    const result=await r.json();
    if(!r.ok){const code=/^[A-Z_]+$/.test(result.message||'')?result.message:'DATABASE_UNAVAILABLE';throw new ApiError(code,statuses[code]||(/^(INVALID_|POSITION_|OUTSIDE_|NO_LOCATIONS)/.test(code)?422:503));}
    return result;
  };
  return async request=>{
    const origin=request.headers.get('origin');
    const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff'};
    if(origin&&origins.includes(origin))headers['Access-Control-Allow-Origin']=origin;
    const send=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
    if(origin&&!origins.includes(origin))return send({code:'ORIGIN_FORBIDDEN'},403);
    if(request.method==='OPTIONS'){if(!origin||!origins.includes(origin))return send({code:'ORIGIN_FORBIDDEN'},403);return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,Idempotency-Key','Access-Control-Max-Age':'600'}});}
    const url=new URL(request.url),path=url.pathname.replace(/^.*\/attendance-api(?=\/|$)/,'').replace(/\/$/,'')||'/';
    if(path==='/health'&&request.method==='GET')return send({configured,serverTime:new Date().toISOString()});
    if(!configured)return send({code:'CONFIGURATION_REQUIRED'},503);
    try{
      if(path==='/session'&&request.method==='POST'){
        const {idToken}=await readJson(request);const profile=await verifyLine(idToken,env.LINE_CHANNEL_ID,fetcher);
        const token=randomToken();const result=await rpc('login',null,{lineSub:profile.sub,name:profile.name,sessionHash:await sha256(token),bootstrapSub:env.BOOTSTRAP_LINE_SUB||null});
        return send({token,...result});
      }
      const hash=await sessionHash(request);
      if(path==='/session'&&request.method==='DELETE')return send(await rpc('logout',hash));
      if(path==='/snapshot'&&request.method==='GET'){
        const from=url.searchParams.get('from'),to=url.searchParams.get('to');
        return send(await rpc('snapshot',hash,dateRange(from,to)));
      }
      if(path==='/exports'&&request.method==='POST'){
        const body=await readJson(request);return send(await rpc('export',hash,dateRange(body.from,body.to,true)));
      }
      if(path==='/punches'&&request.method==='POST'){
        const body=validatePunch(await readJson(request));const key=request.headers.get('idempotency-key');if(!key||!/^[a-zA-Z0-9_-]{16,100}$/.test(key))throw new ApiError('INVALID_IDEMPOTENCY_KEY');
        return send(await rpc('punch',hash,{...body,key,fingerprint:await sha256(canonical(body))}));
      }
      if(path==='/corrections'&&request.method==='POST'){
        const b=await readJson(request);if(!['in','out'].includes(b.type)||!Number.isFinite(Date.parse(b.timestamp))||typeof b.reason!=='string'||b.reason.trim().length<3||b.reason.length>500)throw new ApiError('INVALID_INPUT');
        return send(await rpc('correction',hash,{type:b.type,timestamp:new Date(b.timestamp).toISOString(),reason:b.reason.trim()}));
      }
      if(path==='/corrections/decision'&&request.method==='POST'){
        const b=await readJson(request);if(!['approved','rejected'].includes(b.decision)||typeof b.note!=='string'||b.note.trim().length<3||b.note.length>500||!validId(b.id))throw new ApiError('INVALID_INPUT');
        return send(await rpc('review',hash,{id:b.id,decision:b.decision,note:b.note.trim()}));
      }
      if(path==='/locations'&&request.method==='PUT'){
        const b=await readJson(request);if(typeof b.name!=='string'||!b.name.trim()||b.name.length>60||!Number.isFinite(b.lat)||Math.abs(b.lat)>90||!Number.isFinite(b.lng)||Math.abs(b.lng)>180||!Number.isInteger(b.radiusMeters)||b.radiusMeters<100||b.radiusMeters>100000||typeof b.enabled!=='boolean'||(b.id&&!validId(b.id)))throw new ApiError('INVALID_INPUT');
        return send(await rpc('location',hash,{id:b.id||null,name:b.name.trim(),lat:b.lat,lng:b.lng,radiusMeters:b.radiusMeters,enabled:b.enabled}));
      }
      if(path==='/employees'&&request.method==='PUT'){
        const b=await readJson(request);if(!validId(b.id)||typeof b.name!=='string'||!b.name.trim()||b.name.length>80||!['employee','admin'].includes(b.role)||typeof b.enabled!=='boolean')throw new ApiError('INVALID_INPUT');
        return send(await rpc('employee',hash,{id:b.id,name:b.name.trim(),role:b.role,enabled:b.enabled}));
      }
      throw new ApiError('NOT_FOUND',404);
    }catch(error){if(error instanceof ApiError)return send({code:error.code},error.status);return send({code:'INTERNAL_ERROR'},500);}
  };
}
function validId(id){return typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);}
function dateRange(from,to,required=false){
  if(!required&&!from&&!to)return {};
  for(const value of [from,to])if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw new ApiError('INVALID_INPUT');
  if(from>to||Date.parse(to)-Date.parse(from)>90*86400000)throw new ApiError('INVALID_INPUT');return {from,to};
}
