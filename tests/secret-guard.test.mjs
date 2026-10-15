import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,mkdirSync,copyFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {sensitivePath,detectSecretText,auditRepository} from '../tools/check-secrets.mjs';

test('sensitive filenames are blocked, including uppercase, nested and Chinese paths',()=>{
 for(const name of ['.env','.env.example','.env.production','nested/APP.ENV','nested/credentials.json','certs/key.pem','密碼.docx','機密資料.txt','.aws/credentials','service-account-prod.json','exports/attendance.csv','.secrets','keys.json','api-key.json','app.secrets','config.local.json','token_cache.json'])assert.equal(sensitivePath(name),true,name);
 for(const name of ['frontend/config.js','tools/check-secrets.mjs','.gitignore','.githooks/pre-commit','README.md'])assert.equal(sensitivePath(name),false,name);
});
test('realistic secret formats are detected without returning the secret value',()=>{
 const values=['gh'+'p_'+'A'.repeat(36),'sb_'+'secret_'+'B'.repeat(32),'-----BEGIN '+'PRIVATE KEY-----','CHANNEL_SECRET'+"='"+'c'.repeat(32)+"'",'DATABASE_PASSWORD'+'='+'D'.repeat(24),'postgresql:'+'//'+'postgres:'+'E'.repeat(16)+'@db.invalid/db'];
 for(const value of values){const findings=detectSecretText(value);assert.ok(findings.length);assert.ok(findings.every(f=>!JSON.stringify(f).includes(value)));}
 assert.ok(detectSecretText("DATABASE_SECRET_KEY='server-only'").length);
 assert.ok(detectSecretText('channelSecret'+"='"+'f'.repeat(32)+"'").length);
 assert.equal(detectSecretText("DATABASE_SECRET_KEY='server-only'",{allowFixtures:true}).length,0);
 assert.equal(detectSecretText('DATABASE_SECRET_KEY=\nLINE_CHANNEL_ID=2012025693').length,0);
 assert.equal(detectSecretText("export const config={liffId:'2012025693-u2dzrOVz',apiUrl:'https://meregxzdfizybmnonfza.supabase.co/functions/v1/attendance-api'};").length,0);
});
test('Git integration blocks force-added env files, source credentials and historical secrets',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'attendance-secret-guard-'));
 const git=(args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['pipe','pipe','pipe']});
 try{
  git(['init']);git(['config','user.name','Local test']);git(['config','user.email','test@example.invalid']);
  copyFileSync(fileURLToPath(new URL('../.gitignore',import.meta.url)),join(cwd,'.gitignore'));
  for(const name of ['.env','.env.example','密碼.docx','certs/server.pem','.aws/credentials'])assert.ok(git(['check-ignore','--no-index',name]).trim());
  writeFileSync(join(cwd,'.env'),'');git(['add','-f','.env']);assert.ok(auditRepository({cwd}).findings.some(f=>f.rule==='SENSITIVE_FILENAME'));
  git(['rm','--cached','.env']);
  const secret='gh'+'p_'+'Z'.repeat(36);writeFileSync(join(cwd,'app.js'),'const credential="'+secret+'";');git(['add','app.js']);
  assert.ok(auditRepository({cwd}).findings.some(f=>f.rule==='GITHUB_TOKEN'));
  mkdirSync(join(cwd,'.githooks'));copyFileSync(fileURLToPath(new URL('../tools/check-secrets.mjs',import.meta.url)),join(cwd,'check.mjs'));
  writeFileSync(join(cwd,'.githooks','pre-commit'),'#!/bin/sh\nexec node check.mjs --staged\n');
  git(['config','core.hooksPath','.githooks']);
  assert.throws(()=>git(['commit','-m','blocked synthetic credential']),e=>e.status!==0&&String(e.stderr).includes('BLOCKED')&&!String(e.stderr).includes(secret));
  // Simulate an earlier unsafe commit, then ensure history checking still finds it.
  git(['-c','core.hooksPath=','commit','-m','disposable fixture only']);
  assert.ok(auditRepository({cwd,mode:'--history'}).findings.some(f=>f.rule==='GITHUB_TOKEN'));
 }finally{const target=resolve(cwd);assert.ok(target.startsWith(resolve(tmpdir())+'\\')||target.startsWith(resolve(tmpdir())+'/'));assert.ok(target.includes('attendance-secret-guard-'));rmSync(target,{recursive:true,force:true});}
});
