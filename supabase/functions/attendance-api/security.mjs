export class ApiError extends Error {
  constructor(code, status = 422) { super(code); this.code = code; this.status = status; }
}
export const sha256 = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2,'0')).join('');
export const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b=>b.toString(16).padStart(2,'0')).join('');
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function validatePunch(body) {
  const p = body?.position;
  if (!['in','out'].includes(body?.type) || !p || !Number.isFinite(p.lat) || Math.abs(p.lat)>90 || !Number.isFinite(p.lng) || Math.abs(p.lng)>180 || !Number.isFinite(p.accuracy) || p.accuracy<0 || !Number.isFinite(Date.parse(p.capturedAt))) throw new ApiError('INVALID_INPUT');
  return { type:body.type, position:{lat:p.lat,lng:p.lng,accuracy:p.accuracy,capturedAt:new Date(p.capturedAt).toISOString()} };
}
export async function verifyLine(idToken, channelId, fetcher = fetch, now = Date.now()) {
  if (!channelId) throw new ApiError('CONFIGURATION_REQUIRED',503);
  if (typeof idToken!=='string' || idToken.length<20 || idToken.length>12000) throw new ApiError('INVALID_LINE_TOKEN',401);
  let response;
  try { response=await fetcher('https://api.line.me/oauth2/v2.1/verify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id_token:idToken,client_id:channelId}),signal:AbortSignal.timeout(8000)}); }
  catch { throw new ApiError('LINE_UNAVAILABLE',503); }
  if (!response.ok) throw new ApiError(response.status>=500?'LINE_UNAVAILABLE':'INVALID_LINE_TOKEN',response.status>=500?503:401);
  const claims=await response.json();
  if (claims.iss!=='https://access.line.me' || String(claims.aud)!==String(channelId) || !Number.isFinite(claims.exp) || claims.exp*1000<=now || typeof claims.sub!=='string' || !/^U[0-9a-f]{32}$/i.test(claims.sub)) throw new ApiError('INVALID_LINE_TOKEN',401);
  return {sub:claims.sub,name:typeof claims.name==='string'?claims.name.slice(0,80):'LINE 使用者'};
}
export async function readJson(request) {
  if (!(request.headers.get('content-type')||'').startsWith('application/json')) throw new ApiError('INVALID_CONTENT_TYPE',415);
  const reader=request.body?.getReader(); if (!reader) throw new ApiError('INVALID_INPUT');
  const chunks=[]; let size=0;
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>16000){await reader.cancel();throw new ApiError('PAYLOAD_TOO_LARGE',413);}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try {const body=JSON.parse(new TextDecoder().decode(bytes));if(!body||Array.isArray(body)||typeof body!=='object')throw new Error();return body;}catch{throw new ApiError('INVALID_INPUT');}
}
export function sessionHash(request) {
  const match=/^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization')||'');
  if(!match)throw new ApiError('UNAUTHENTICATED',401);
  return sha256(match[1]);
}
