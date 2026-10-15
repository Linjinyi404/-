// Offline checks only. Report filenames, line numbers and rule names; never values.
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const knownFixture=value=>['server-only','test-only','only-a-test-fixture','sb_secret_test_only'].includes(value);
const publicEnvExampleBlobs=new Set(['f6e624d84fb15f1712c73c5d99936c9894db10ef','712d2f793ad0dd4513fc42ea5593a2493217e84c']);
export function sensitivePath(path){
 const parts=path.replaceAll('\\','/').split('/'),name=parts.at(-1);
 return parts.some(p=>/^(?:\.aws|\.azure|\.ssh|\.supabase|keys|secrets|private|confidential|backups|exports)$/i.test(p))
  || /^(?:\.env.*|.*\.env(?:\..*)?|\.dev\.vars.*|\.credentials.*|credentials(?:\..*)?|secrets(?:\..*)?|auth\.json|tokens?\.json|client_secret.*\.json|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.pg_service\.conf|\.my\.cnf|id_(?:rsa|dsa|ecdsa|ed25519).*)$/i.test(name)
  || /(?:password|passwd|密碼|密码|帳密|賬密|機密|机密|金鑰|金钥|私鑰|私钥)/i.test(name)
  || /^(?:\.secrets.*|keys\..*|key\.json|api[-_]key.*\.json|config\.(?:local|secret|private)\..*|token.*\.json)$/i.test(name)
  || /\.(?:credentials|secrets?|secret\..*)$/i.test(name)
  || /(?:\.credentials\.|\.secrets\.|service[-_]account.*\.json$|firebase-adminsdk.*\.json$)/i.test(name)
  || /\.(?:pem|key|p8|p12|pfx|jks|keystore|crt|cer|der|csr|mobileprovision|dump|backup|bak|sqlite3?|db|sql\.gz|tfstate(?:\..*)?)$/i.test(name);
}
export function detectSecretText(text,{allowFixtures=false}={}){
 const findings=[];
 const add=(rule,index)=>findings.push({rule,line:text.slice(0,index).split('\n').length});
 const rules=[
  ['PRIVATE_KEY',/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g],
  ['GITHUB_TOKEN',/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{35,})\b/g],
  ['SUPABASE_SECRET',/\bsb_secret_[A-Za-z0-9_-]{16,}\b/g],
  ['GOOGLE_API_KEY',/\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['AWS_ACCESS_KEY',/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['SLACK_TOKEN',/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['STRIPE_SECRET',/\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g],
  ['OPENAI_SECRET',/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g]
 ];
 for(const [rule,re] of rules)for(const m of text.matchAll(re))add(rule,m.index);
 for(const m of text.matchAll(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{12,}\b/g)){
  try{const payload=JSON.parse(Buffer.from(m[0].split('.')[1],'base64url'));if(payload.role!=='anon')add('JWT_CREDENTIAL',m.index);}catch{}
 }
 const key='[A-Za-z_]*(?:password|passwd|pwd|channel_?secret|client_?secret|api_?key|service_?role_?key|database_?secret_?key|access_?token|refresh_?token|auth_?token|private_?key|secret_?key|jwt_?secret)[A-Za-z_]*';
 for(const m of text.matchAll(new RegExp('\\b('+key+')["\']?[ \\t]*(?:=|:)[ \\t]*(["\'])([^"\'\\r\\n]{1,})\\2','gi')))if(!(allowFixtures&&knownFixture(m[3])))add('SECRET_ASSIGNMENT',m.index);
 for(const m of text.matchAll(new RegExp('^[ \\t]*(?:export[ \\t]+)?('+key+')[ \\t]*=[ \\t]*([^\\s#"\']+)','gmi')))if(!(allowFixtures&&knownFixture(m[2])))add('ENV_SECRET_ASSIGNMENT',m.index);
 for(const m of text.matchAll(/(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^/\s:@]+:([^@\s/]+)@/gi))add('DATABASE_PASSWORD_URL',m.index);
 return findings;
}

export function auditRepository({cwd=process.cwd(),mode='--staged'}={}){
 const git=(args,input)=>execFileSync('git',args,{cwd,input,encoding:'utf8',maxBuffer:128*1024*1024,stdio:['pipe','pipe','pipe']});
 const findings=[],historicalEnvExamples=[];let inspected=0;
 const check=(path,content,object)=>{
  inspected++;const matches=detectSecretText(content,{allowFixtures:/(?:^|\/)(?:tests\/|tools\/(?:browser-qa|gps-qa-server)\.mjs$)/.test(path)});
  // Historical settings examples contained public IDs and empty secret fields.
  const oldExample=mode==='--history'&&publicEnvExampleBlobs.has(object)&&/\.env\.example$/i.test(path)&&!matches.length;
  if(oldExample)historicalEnvExamples.push({path,object});
  if(sensitivePath(path)&&!oldExample)findings.push({path,rule:'SENSITIVE_FILENAME',...(object?{object}:{})});
  for(const item of matches)findings.push({path,...item,...(object?{object}:{})});
 };
 if(mode==='--history'){
  const objects=git(['-c','core.quotePath=false','rev-list','--objects','--all']).trim().split('\n').filter(Boolean).map(row=>{const i=row.indexOf(' ');return {sha:i<0?row:row.slice(0,i),path:i<0?'':row.slice(i+1)};});
  const types=git(['cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],objects.map(o=>o.sha).join('\n')+'\n').trim().split('\n');
  for(let i=0;i<objects.length;i++)if(types[i].split(' ')[1]==='blob'){
   const {sha,path}=objects[i];if(Number(types[i].split(' ')[2])>4*1024*1024){findings.push({path,object:sha,rule:'OVERSIZED_BLOB_REQUIRES_REVIEW'});continue;}
   check(path,git(['cat-file','blob',sha]),sha);
  }
 }else{
  const args=mode==='--tracked'?['ls-files','-z']:['diff','--cached','--name-only','--diff-filter=ACMR','-z'];
  for(const path of git(args).split('\0').filter(Boolean))check(path,git(['show',':'+path]));
 }
 return {mode,inspected,findings,historicalEnvExamples};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const mode=process.argv[2]||'--staged';if(!['--staged','--tracked','--history'].includes(mode))throw new Error('INVALID_MODE');
  const result=auditRepository({mode});
  if(result.findings.length){console.error('Secret check BLOCKED. Values are hidden.');for(const f of result.findings)console.error(`${f.path}${f.line?':'+f.line:''}: ${f.rule}`);process.exitCode=1;}
  else console.log(`Secret check passed: ${result.inspected} objects/files (${mode}).`);
  if(result.historicalEnvExamples.length)console.log(`Historical public env examples reviewed: ${result.historicalEnvExamples.length}. Future env files are blocked.`);
 }catch{console.error('Secret check could not complete. Commit blocked; no secret values displayed.');process.exitCode=1;}
}
