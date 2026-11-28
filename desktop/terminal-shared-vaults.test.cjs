'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {registerSharedVault} = require('./terminal/shared-vault-host.cjs');
const {validateAccountRequest} = require('./account.cjs');
function fixture(accountRequest) {
  let current = {userId:'alice'}, user = {id:'alice'}, invoke;
  registerSharedVault({handle:(_name,fn) => {invoke=fn;}, accountRequest,
    localUser:async () => user, scope:() => current});
  return {invoke, scope:value => {current=value;}, login:id => {user={id};}};
}
test('shared vault bridge binds the scope to the authenticated local account and fixes the API route', async () => {
  let captured;
  const f = fixture(async input => {captured=input; return {userId:'alice',vaults:[]};});
  assert.deepEqual(await f.invoke('list',{action:'delete',expectedUserId:'bob'}),{userId:'alice',vaults:[]});
  assert.deepEqual(captured,{path:'/api/account/apps/terminal/shared-vaults',method:'POST',body:{action:'list',expectedUserId:'alice'}});
  assert.throws(() => validateAccountRequest(captured));
  f.login('bob');
  await assert.rejects(f.invoke('list'),/账号/);
  f.scope({userId:'bob',temporary:true});
  await assert.rejects(f.invoke('list'),/先登录/);
});
test('closing the view or switching accounts while a request is pending withholds results', async () => {
  let f = fixture(async () => {f.scope({userId:'alice'});return {userId:'alice'};});
  await assert.rejects(f.invoke('open'),/账号/);
  f = fixture(async () => {f.login('bob');return {userId:'alice'};});
  await assert.rejects(f.invoke('open'),/账号/);
  f = fixture(async () => ({userId:'bob'}));
  await assert.rejects(f.invoke('open'),/账号/);
});
