import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleAccount} from '../src/accounts.js';
import {digest, seal} from '../src/accounts-crypto.js';
import {appDataPath} from '../src/account-store.js';
import {sharedVaultRoute} from '../src/terminal-shared-vaults.js';

const vaultId = '94669d49-44ba-4ce6-9013-0d4bd8e1fbce';
const host = {name:'机房',host:'host.example',user:'operator',port:22};
async function fixture() {
  const env = {SESSION_SECRET:'shared vault integration fixture secret only', ACCOUNT_LIMITER:{limit:async () => ({success:true})}};
  const files = new Map(), tokens = {}, ids = ['alice','bob','clara'];
  const expiry = Math.floor(Date.now()/1000) + 600;
  for (const id of ids) {
    const sid = 'fixture-' + id;
    tokens[id] = await seal({typ:'account',id,sid,csrf:'test-token',mode:'native',exp:expiry},env.SESSION_SECRET);
    files.set('users/' + id + '/credentials.json',{version:1,sessions:{[await digest(sid)]:{mode:'native',exp:expiry}}});
    files.set('users/' + id + '/profile.json',{version:1,id,username:id.toUpperCase()});
    files.set(appDataPath(id,'terminal'),{version:1,revision:1,data:{hosts:[{...host,name:'personal-' + id}], forwards:[]}});
  }
  files.set('users/_index.json',{version:1,usernames:Object.fromEntries(ids.map(id => [id,id]))});
  const read = (source, path, fallback) => structuredClone(source.has(path) ? source.get(path) : fallback);
  let queue = Promise.resolve(), beforeMutation;
  const store = {
    async snapshot() {
      const current = new Map(files);
      return {read:(path,fallback=null) => read(current,path,fallback)};
    },
    transaction(mutate) {
      const op = queue.then(async () => {
        beforeMutation?.();
        const staged = new Map(files);
        const result = await mutate({read:(path,fallback=null) => read(staged,path,fallback),write:(path,value) => staged.set(path,structuredClone(value))});
        for (const [path,value] of staged) files.set(path,value);
        return result;
      });
      queue = op.catch(() => {});
      return op;
    },
  };
  const call = async (id,action,payload = {}, path = sharedVaultRoute) => {
    const response = await handleAccount(new Request('https://tools.brclio.com' + path,{
      method:'POST', headers:{'X-Brclio-Client':'native','Content-Type':'application/json',
        ...(id ? {Authorization:'Bearer ' + tokens[id]} : {})},body:JSON.stringify({expectedUserId:id,action,...payload})}),env,{accountStore:store});
    return {status:response.status, ...await response.json()};
  };
  const ref = {ownerId:'alice',vaultId};
  const change = (id,action,revision,payload) => call(id,action,{...ref,revision,...payload});
  const create = () => call('alice','create',{name:'团队联调',vaultId});
  return {files, call, create, change, ref, before:fn => {beforeMutation=fn;}};
}

test('shared vaults require an authenticated account, explicit invitation and acceptance; private records never enter a shared vault', async () => {
  const f = await fixture();
  assert.equal((await f.call(null,'list')).status,401);
  assert.equal((await f.call('bob','list',{expectedUserId:'alice'})).status,409);
  assert.equal((await f.call('bob','list',{},'/api/account/apps/terminal-vault-list/data')).status,404);
  const privateData = structuredClone(f.files.get(appDataPath('alice','terminal')));
  assert.deepEqual((await f.create()).vault.hosts,[]);
  assert.deepEqual((await f.create()).vault.hosts,[]);
  assert.equal((await f.call('alice','list')).vaults.length,1);
  assert.equal((await f.change('alice','set-hosts',1,{hosts:[host]})).status,200);
  assert.equal((await f.call('bob','open',f.ref)).status,404);
  assert.equal((await f.call('clara','list')).vaults.length,0);
  assert.equal((await f.change('alice','invite',2,{username:'BOB',role:'reader'})).status,200);
  const invitation = (await f.call('bob','open',f.ref)).vault;
  assert.equal(invitation.state,'invited');
  assert.equal('hosts' in invitation,false);
  assert.equal('members' in invitation,false);
  assert.equal((await f.change('bob','set-hosts',3,{hosts:[]})).status,403);
  assert.equal((await f.change('clara','accept',3)).status,404);
  assert.deepEqual((await f.change('bob','accept',3)).vault.hosts,[host]);
  assert.equal((await f.change('bob','set-hosts',4,{hosts:[]})).status,403);
  assert.equal((await f.change('bob','role',4,{memberId:'bob',role:'editor'})).status,403);
  assert.equal((await f.change('alice','role',4,{memberId:'bob',role:'editor'})).status,200);
  assert.equal((await f.change('bob','invite',5,{username:'clara',role:'reader'})).status,403);
  assert.equal((await f.change('bob','set-hosts',5,{hosts:[]})).status,200);
  assert.equal((await f.change('alice','revoke',6,{memberId:'bob'})).status,200);
  assert.deepEqual((await f.call('bob','list')).vaults,[]);
  assert.equal((await f.change('bob','set-hosts',6,{hosts:[host]})).status,404);
  assert.equal((await f.call('bob','open',f.ref)).status,404);
  assert.deepEqual(f.files.get(appDataPath('alice','terminal')),privateData);
});

test('stale revisions fail closed, invitations can be declined and members can leave; deleting the vault clears discovery', async () => {
  const f = await fixture(); await f.create();
  const changes = await Promise.all([[],[host]].map(hosts => f.change('alice','set-hosts',1,{hosts})));
  assert.deepEqual(changes.map(r => r.status).sort(),[200,409]);
  await f.change('alice','invite',2,{username:'bob',role:'editor'});
  assert.equal((await f.change('bob','decline',3)).removed,true);
  assert.equal((await f.call('bob','open',f.ref)).status,404);
  await f.change('alice','invite',4,{username:'bob',role:'editor'});
  await f.change('bob','accept',5);
  assert.equal((await f.change('bob','leave',6)).removed,true);
  await f.change('alice','invite',7,{username:'clara',role:'reader'});
  assert.equal((await f.change('alice','delete',8)).removed,true);
  assert.deepEqual((await f.call('alice','list')).vaults,[]);
  assert.deepEqual((await f.call('clara','list')).vaults,[]);
  assert.equal((await f.call('clara','open',f.ref)).status,404);
  assert.equal((await f.create()).status,409);
});

test('host schema rejects credentials, local paths and commands; malformed actions or revoked grants never mutate', async () => {
  const f = await fixture(); await f.create();
  for (const field of ['password','privateKey','identityFile','certificateFile','agentForwarding','startupCommand','transcript','jump','tags']) {
    assert.equal((await f.change('alice','set-hosts',1,{hosts:[{...host,[field]:'private material'}]})).status,400);
  }
  assert.equal((await f.call('alice','open',{...f.ref,ownerId:'../alice'})).status,400);
  assert.equal((await f.change('alice','invite',1,{username:'bob',role:'owner'})).status,400);
  assert.equal((await f.change('alice','invite',1,{username:'constructor',role:'reader'})).status,404);
  assert.equal((await f.call('bob','list',{ownerId:'alice'})).status,400);
  assert.equal((await f.call('alice','open',f.ref)).vault.revision,1);
  f.before(() => { f.files.get('users/alice/credentials.json').sessions = {}; });
  assert.equal((await f.change('alice','set-hosts',1,{hosts:[host]})).status,401);
});
