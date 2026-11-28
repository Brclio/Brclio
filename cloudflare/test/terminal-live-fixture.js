import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {seal,digest} from '../src/accounts-crypto.js';
import {sharedVaultPath} from '../src/terminal-shared-vaults.js';

export async function liveFixture() {
  const root = fileURLToPath(new URL('..',import.meta.url));
  const secret = 'integration test only live-view signing key';
  const records = new Map(), tokens = {};
  const expires = Math.floor(Date.now()/1000)+600;
  const ids = ['fixture-alice','fixture-bob','fixture-clara'];
  for (const id of ids) {
    const sid = 'terminal-live-fixture-' + id;
    const claims = {typ:'account',id,sid,csrf:'live-csrf',mode:'native',exp:expires};
    tokens[id] = await seal(claims,secret);
    records.set('users/' + id + '/credentials.json',{version:1,sessions:{[await digest(sid)]:{mode:'native',exp:expires}}});
    records.set('users/' + id + '/profile.json',{version:1,id,username:id,email:id+'@example.test'});
  }
  const [ownerId,viewerId] = ids, vaultId = '5edfc17c-48bb-4359-83f5-4abd7aa017e1', ref = {ownerId,vaultId};
  const metadata = {...ref,name:'值班组',ownerName:ownerId};
  records.set(sharedVaultPath(ownerId,vaultId),{version:1,revision:1,...metadata,hosts:[],
    members:[{id:viewerId,username:viewerId,role:'reader',state:'active'}]});
  for (const id of [ownerId,viewerId]) {
    records.set('users/' + id + '/apps/terminal-vault-list/data.json',{version:1,
      vaults:[{...metadata,role:id === ownerId ? 'owner' : 'reader',state:'active'}]});
  }
  const code = `
    import beta,{TerminalLiveRoom as ActualRoom,accountRequest} from './src/terminal-live-beta.js';
    import {handleAccount} from './src/accounts.js';
    function store(env) {
      const view = {async read(path,fallback=null) {
        const reply = await env.RECORDS.fetch('https://fixture/' + path);
        return reply.status === 404 ? fallback : reply.json();
      },write() {throw new Error('read-only fixture');}};
      return {snapshot:async () => view,transaction:fn => fn(view)};
    }
    export {ActualRoom as TerminalLiveRoom};
    export default {fetch(req,env) {
      const path = new URL(req.url).pathname;
      if (path === '/api/account/apps/terminal/live-view') {
        const accounts = {fetch:r => handleAccount(r,env,{accountStore:store(env)})};
        return accountRequest(req,{...env,BRCLIO_ACCOUNTS:accounts});
      }
      if (path.startsWith('/api/account/')) return handleAccount(req,env,{accountStore:store(env)});
      return beta.fetch(req,env);
    }};
  `;
  const built = await build({stdin:{contents:code,resolveDir:root},format:'esm',platform:'browser',target:'es2022',bundle:true,
    external:['cloudflare:*','node:*'],write:false,logLevel:'silent',loader:{'.txt':'text','.html':'text','.css':'text'}});
  const mf = new Miniflare(convertV4MiniflareOptions({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-10-18',
    compatibilityFlags:['nodejs_compat'],durableObjects:{TERMINAL_LIVE_ROOMS:{className:'TerminalLiveRoom',useSQLite:true}},
    bindings:{SESSION_SECRET:secret},serviceBindings:{RECORDS:req => {
      const key = new URL(req.url).pathname.slice(1);
      return records.has(key) ? Response.json(records.get(key)) : new Response(null,{status:404});
    }}}));
  const url = await mf.ready;
  return {mf,url,records,tokens,ref,viewerId,
    revoke() {records.get(sharedVaultPath(ownerId,vaultId)).members=[];}};
}
