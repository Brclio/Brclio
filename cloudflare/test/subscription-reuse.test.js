import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {getNodes,readConfig,writeConfig,clearConfigCache,VALIDATED_SUBSCRIPTION_TTL_MS} from '../src/config.js';

const env = {GITHUB_PROGRAM_DATA_REPOSITORY:'fixture/program',GITHUB_DATA_REPOSITORY:'fixture/users',PROXY_SUBSCRIPTION_URL:'https://subscription.example/sub',ADMIN_EMAIL:'admin@example.com'};
const sha = 'a'.repeat(40), otherSHA = 'b'.repeat(40);
const tokenProvider = async (received, repository) => {assert.equal(repository,received.GITHUB_PROGRAM_DATA_REPOSITORY);return 'fixture-program-token';};
const optIn = {reuseValidatedSubscription:true,tokenProvider};
const document = path => Response.json({proxies:[{type:'vless',uuid:'00000000-0000-4000-8000-000000000001',server:'route.example.com',servername:'route.example.com',port:443,tls:true,network:'ws','ws-opts':{path}}]});
const deferred = () => {let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function setup(t) {
  clearConfigCache();t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  t.after(()=>{t.mock.timers.reset();clearConfigCache();});
  return async ms=>{t.mock.timers.tick(ms);await setImmediate();};
}
function fixture() {
  const state={sha,url:env.PROXY_SUBSCRIPTION_URL,version:1,status:200,path:'/first',privateReads:0,subscriptions:0,puts:0};
  const fetchImpl=async(target,options)=>{
    if(String(target).startsWith('https://api.github.com/repos/')) {
      assert.equal(options.headers.Authorization,'Bearer fixture-program-token');
      assert.ok(!String(target).includes('/fixture/users/'));
      if(options.method==='PUT'){state.puts++;return Response.json({content:{sha:state.sha}});}
      state.privateReads++;
      if(state.status!==200)return new Response('',{status:state.status});
      const content=Buffer.from(JSON.stringify({version:state.version,subscriptionUrl:state.url}));
      return Response.json({sha:state.sha,size:content.length,encoding:'base64',content:content.toString('base64')});
    }
    assert.equal(new Headers(options.headers).has('authorization'),false);assert.equal(options.redirect,'manual');
    state.subscriptions++;
    return state.readSubscription?state.readSubscription(target,options):document(state.path);
  };
  return {state,fetchImpl,get:(options=optIn,received=env)=>getNodes(received,fetchImpl,options)};
}

test('opt-in checks fresh GitHub on every request while fixed 15-second subscription reuse never slides',async t=>{
  const tick=setup(t),f=fixture();
  const first=await f.get();assert.equal(f.state.privateReads,1);assert.equal(f.state.subscriptions,1);
  await tick(VALIDATED_SUBSCRIPTION_TTL_MS-1);
  assert.equal(await f.get(),first);assert.equal(f.state.privateReads,2);assert.equal(f.state.subscriptions,1);
  assert.throws(()=>{first[0].path='/poisoned';},TypeError);
  await tick(1);f.state.path='/refreshed';
  assert.equal((await f.get())[0].path,'/refreshed');assert.equal(f.state.privateReads,3);assert.equal(f.state.subscriptions,2);
});

test('the 15-second lifetime starts only after a complete validated response',async t=>{
  const tick=setup(t),f=fixture(),held=deferred();f.state.readSubscription=()=>held.promise;
  const pending=f.get();await tick(5500);held.resolve(document('/completed'));const first=await pending;
  await tick(14999);assert.equal(await f.get(),first);assert.equal(f.state.subscriptions,1);
  f.state.readSubscription=()=>document('/new');await tick(1);
  assert.equal((await f.get())[0].path,'/new');assert.equal(f.state.subscriptions,2);
});

test('repository, full configuration SHA and normalized URL independently scope reuse',async t=>{
  setup(t);const f=fixture();await f.get();
  f.state.url='https://subscription.example:443/sub';await f.get();assert.equal(f.state.subscriptions,1);
  f.state.sha=otherSHA;f.state.path='/sha-changed';assert.equal((await f.get())[0].path,'/sha-changed');assert.equal(f.state.subscriptions,2);
  f.state.url='https://subscription.example/changed';f.state.path='/url-changed';assert.equal((await f.get())[0].path,'/url-changed');assert.equal(f.state.subscriptions,3);
  f.state.path='/repo-changed';const other={...env,GITHUB_PROGRAM_DATA_REPOSITORY:'fixture/other-program'};
  assert.equal((await f.get(optIn,other))[0].path,'/repo-changed');assert.equal(f.state.subscriptions,4);
  assert.equal((await f.get())[0].path,'/url-changed');assert.equal(f.state.subscriptions,4);
});

test('missing or invalid SHA and deployment fallback responses cannot use or populate short reuse',async t=>{
  setup(t);const f=fixture();await f.get();let expected=1;
  for(const value of [undefined,null,'','a'.repeat(39),'A'.repeat(40),42]) {
    f.state.sha=value;await f.get();await f.get();expected+=2;assert.equal(f.state.subscriptions,expected);
  }
  f.state.status=404;await f.get();await f.get();assert.equal(f.state.subscriptions,expected+2);
});

test('fresh GitHub errors, invalid versions and expiry never fall back to previously validated nodes',async t=>{
  const tick=setup(t),f=fixture();await f.get();
  f.state.status=500;await assert.rejects(f.get(),/读取私有配置失败/);assert.equal(f.state.subscriptions,1);
  f.state.status=200;f.state.version=2;await assert.rejects(f.get(),/读取私有配置失败/);assert.equal(f.state.subscriptions,1);
  f.state.version=1;await tick(15000);f.state.readSubscription=()=>new Response('',{status:403});
  await assert.rejects(f.get(),/无法读取代理订阅/);await assert.rejects(f.get(),/无法读取代理订阅/);
  assert.equal(f.state.privateReads,5);assert.equal(f.state.subscriptions,3);
});

test('same-key concurrent opt-ins each check GitHub but share only a complete validated subscription',async t=>{
  const tick=setup(t),f=fixture(),held=deferred();f.state.readSubscription=()=>held.promise;
  let completed=0;const requests=Array.from({length:5},()=>f.get().then(nodes=>{completed++;return nodes;}));
  await tick(0);assert.equal(f.state.privateReads,5);assert.equal(f.state.subscriptions,1);assert.equal(completed,0);
  held.resolve(document('/shared'));const nodes=await Promise.all(requests);
  assert.equal(completed,5);assert.ok(nodes.every(value=>value===nodes[0]));assert.equal(nodes[0][0].path,'/shared');
});

test('a failed shared validation rejects every waiter and leaves no rejected entry or cached nodes',async t=>{
  const tick=setup(t),f=fixture(),held=deferred();f.state.readSubscription=()=>held.promise;
  const requests=Promise.allSettled([f.get(),f.get(),f.get()]);await tick(0);assert.equal(f.state.subscriptions,1);
  held.resolve(new Response('{"proxies":[]}'));const results=await requests;
  assert.ok(results.every(result=>result.status==='rejected'));f.state.readSubscription=()=>document('/recovered');
  assert.equal((await f.get())[0].path,'/recovered');assert.equal(f.state.subscriptions,2);
});

test('default fresh calls still bypass all node caches and never join an opted-in flight',async t=>{
  const tick=setup(t),f=fixture();await f.get();
  await f.get({fresh:true,tokenProvider});await f.get({fresh:true,tokenProvider});assert.equal(f.state.subscriptions,3);
  clearConfigCache();const held=deferred();f.state.readSubscription=()=>f.state.subscriptions===4?held.promise:document('/strict-fresh');
  const shared=f.get();await tick(0);
  assert.equal((await f.get({fresh:true,tokenProvider}))[0].path,'/strict-fresh');assert.equal(f.state.subscriptions,5);
  held.resolve(document('/opt-in'));assert.equal((await shared)[0].path,'/opt-in');
});

test('an existing long-lived node cache cannot seed the opt-in short lifetime',async t=>{
  const tick=setup(t),f=fixture();await f.get({tokenProvider});await tick(30000);
  f.state.path='/new-opt-in';assert.equal((await f.get())[0].path,'/new-opt-in');
  assert.equal(f.state.privateReads,2);assert.equal(f.state.subscriptions,2);
});

test('clear invalidates both reuse and flights without an old completion replacing or deleting a new flight',async t=>{
  const tick=setup(t),f=fixture(),old=deferred(),current=deferred();
  f.state.readSubscription=()=>f.state.subscriptions===1?old.promise:current.promise;
  const beforeClear=f.get();await tick(0);clearConfigCache();
  const afterClear=f.get();await tick(0);assert.equal(f.state.subscriptions,2);
  old.resolve(document('/old'));await beforeClear;
  const joined=f.get();await tick(0);assert.equal(f.state.subscriptions,2);
  current.resolve(document('/current'));await Promise.all([afterClear,joined]);
  assert.equal((await f.get())[0].path,'/current');assert.equal(f.state.subscriptions,2);
});

test('administrator saves clear short reuse even when the write response reports the same SHA',async t=>{
  setup(t);const f=fixture();await f.get();
  const result=await writeConfig(env,{subscriptionUrl:f.state.url,sha},f.fetchImpl,{tokenProvider});assert.equal(result.sha,sha);assert.equal(f.state.puts,1);
  f.state.path='/after-save';assert.equal((await f.get())[0].path,'/after-save');assert.equal(f.state.subscriptions,3);
});

test('a clear during a private-config read prevents that old request from refilling the short cache',async t=>{
  const tick=setup(t),f=fixture(),held=deferred();let first=true;
  const delayed=async(target,options)=>{const response=await f.fetchImpl(target,options);if(first&&String(target).startsWith('https://api.github.com/')){first=false;await held.promise;}return response;};
  const old=getNodes(env,delayed,optIn);await tick(0);clearConfigCache();held.resolve();await old;
  await f.get();assert.equal(f.state.privateReads,2);assert.equal(f.state.subscriptions,2);
});

test('pre-clear default reads also cannot refill the private-config or legacy node caches',async t=>{
  const tick=setup(t),f=fixture(),configHeld=deferred();let first=true;
  const delayedConfig=async(target,options)=>{const response=await f.fetchImpl(target,options);if(first){first=false;await configHeld.promise;}return response;};
  const beforeConfigClear=readConfig(env,{fresh:true,fetchImpl:delayedConfig,tokenProvider});await tick(0);
  clearConfigCache();f.state.url='https://subscription.example/after-clear';configHeld.resolve();await beforeConfigClear;
  assert.equal((await readConfig(env,{fetchImpl:f.fetchImpl,tokenProvider})).subscriptionUrl,f.state.url);assert.equal(f.state.privateReads,2);
  const held=deferred();f.state.readSubscription=()=>held.promise;
  const beforeNodesClear=f.get({fresh:true,tokenProvider});await tick(0);clearConfigCache();held.resolve(document('/old'));await beforeNodesClear;
  f.state.readSubscription=()=>document('/after-clear');
  assert.equal((await f.get({tokenProvider}))[0].path,'/after-clear');assert.equal(f.state.subscriptions,2);
});

test('completed reuse retains at most sixteen distinct keys',async t=>{
  setup(t);const f=fixture();
  for(let i=0;i<17;i++)await f.get(optIn,{...env,GITHUB_PROGRAM_DATA_REPOSITORY:'fixture/program-'+i});
  assert.equal(f.state.subscriptions,17);
  await f.get(optIn,{...env,GITHUB_PROGRAM_DATA_REPOSITORY:'fixture/program-16'});assert.equal(f.state.subscriptions,17);
  await f.get(optIn,{...env,GITHUB_PROGRAM_DATA_REPOSITORY:'fixture/program-0'});assert.equal(f.state.subscriptions,18);
});

test('only sixteen distinct flights are retained; capacity overflow uses fresh reads without unbounded sharing',async t=>{
  const tick=setup(t),f=fixture(),pending=[];f.state.readSubscription=()=>{const value=deferred();pending.push(value);return value.promise;};
  const requests=Array.from({length:17},(_,i)=>f.get(optIn,{...env,GITHUB_PROGRAM_DATA_REPOSITORY:'fixture/program-'+i}));
  await tick(0);assert.equal(f.state.subscriptions,17);
  requests.push(f.get(optIn,{...env,GITHUB_PROGRAM_DATA_REPOSITORY:'fixture/program-0'}));
  requests.push(f.get(optIn,{...env,GITHUB_PROGRAM_DATA_REPOSITORY:'fixture/program-16'}));
  await tick(0);assert.equal(f.state.subscriptions,18);
  for(const value of pending)value.resolve(document('/bounded'));await Promise.all(requests);
});
