import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSession,sessionFrom,safeEqual,sameOrigin,clearSessionCookie} from '../src/auth.js';
const env={ADMIN_EMAIL:'admin@example.com',SESSION_SECRET:'test-session-secret-with-at-least-32-characters'};
test('admin sessions are signed, HttpOnly Secure Strict and reject tampering or identity changes',async()=>{
  const session=await createSession(env);assert.match(session.cookie,/^__Host-brclio_admin=/);assert.match(session.cookie,/HttpOnly; Secure; SameSite=Strict/);
  const cookie=session.cookie.split(';')[0];const request=new Request('https://updates.example/api/admin/config',{headers:{cookie}});
  assert.equal((await sessionFrom(request,env)).csrf,session.csrf);
  assert.equal(await sessionFrom(new Request(request,{headers:{cookie:cookie.replace(/\.([A-Za-z0-9_-])/,(_,char)=>'.'+(char==='A'?'B':'A'))}}),env),null);
  assert.equal(await sessionFrom(request,{...env,ADMIN_EMAIL:'changed@example.com'}),null);
  assert.equal(await sessionFrom(request,{...env,SESSION_SECRET:'different-secret-with-at-least-32-characters'}),null);
  assert.match(clearSessionCookie(),/Max-Age=0/);
});
test('credentials use fixed digest comparisons and origin protection excludes cross-origin mutations',async()=>{
  assert.equal(await safeEqual('correct','correct'),true);assert.equal(await safeEqual('wrong','correct'),false);
  assert.equal(sameOrigin(new Request('https://updates.example/api/admin/login',{headers:{origin:'https://updates.example'}})),true);
  assert.equal(sameOrigin(new Request('https://updates.example/api/admin/login',{headers:{origin:'https://evil.example'}})),false);
  assert.equal(sameOrigin(new Request('https://updates.example/api/admin/login')),false);
});
