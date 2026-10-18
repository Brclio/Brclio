import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readConfig,writeConfig,getNodes,clearConfigCache,CONFIG_PATH,NODES_CACHE_TTL_MS} from '../src/config.js';
const env={ADMIN_EMAIL:'admin@example.com',GITHUB_TOKEN:'test-token',GITHUB_DATA_REPOSITORY:'BrclioData/BrclioData',PROXY_SUBSCRIPTION_URL:'https://subscription.example/sub'};
const subscription=JSON.stringify({proxies:[{type:'vless',uuid:'00112233-4455-6677-8899-aabbccddeeff',tls:true,network:'ws',servername:'vpn.example.com',port:443,'ws-opts':{path:'/tunnel',headers:{Host:'vpn.example.com'}}}]});
const file=(sha,url)=>({sha,size:100,encoding:'base64',content:Buffer.from(JSON.stringify({subscriptionUrl:url,updatedAt:'2026-10-18T00:00:00.000Z'})).toString('base64')});
test('missing config uses deployment env; GitHub authorization never enters stored config',async()=>{
  clearConfigCache();const response=await readConfig(env,{fresh:true,fetchImpl:async(url,init)=>{assert.ok(url.endsWith(CONFIG_PATH));assert.equal(init.headers.Authorization,'Bearer test-token');return new Response('',{status:404});}});
  assert.deepEqual(response,{subscriptionUrl:env.PROXY_SUBSCRIPTION_URL,sha:null,updatedAt:null});
});
test('optimistic SHA conflict does not overwrite newer private config or fetch subscription',async()=>{
  clearConfigCache();let calls=0;
  const result=await writeConfig(env,{subscriptionUrl:'https://subscription.example/new',sha:'stale'},async()=>{calls++;return Response.json(file('current','https://subscription.example/old'));});
  assert.equal(result.conflict,true);assert.equal(calls,1);
});
test('saved config contains subscription only, checks compatible nodes, writes exact current SHA',async()=>{
  clearConfigCache();let put;
  const result=await writeConfig(env,{subscriptionUrl:'https://subscription.example/new',sha:'old'},async(url,init)=>{
    if(String(url).includes('subscription.example')){assert.equal(init.headers['User-Agent'],'clash.meta');assert.equal(init.headers['Cache-Control'],'no-cache, no-store');assert.equal(init.headers.Pragma,'no-cache');assert.equal(init.headers.Authorization,undefined);return new Response(subscription);}
    if(init.method==='PUT'){put=JSON.parse(init.body);return Response.json({content:{sha:'new-sha'}});}
    return Response.json(file('old','https://subscription.example/old'));
  });
  assert.equal(result.sha,'new-sha');assert.equal(result.compatibleNodes,1);assert.equal(put.sha,'old');
  const stored=JSON.parse(Buffer.from(put.content,'base64').toString());assert.equal(stored.subscriptionUrl,'https://subscription.example/new');assert.equal(stored.updatedBy,env.ADMIN_EMAIL);assert.ok(!JSON.stringify(stored).includes(env.GITHUB_TOKEN));
});
test('authenticated GitHub configuration requests explicitly reject redirects',async()=>{
  clearConfigCache();let redirect;
  await assert.rejects(()=>readConfig(env,{fresh:true,fetchImpl:async(url,init)=>{redirect=init.redirect;throw new Error('redirect blocked');}}));
  assert.equal(redirect,'manual');
});

test('GitHub manual redirects are canceled without following the credentialed request',async()=>{
  clearConfigCache();let calls=0;
  await assert.rejects(()=>readConfig(env,{fresh:true,fetchImpl:async(url,init)=>{calls++;assert.equal(init.redirect,'manual');return new Response('',{status:302,headers:{location:'https://attacker.example'}});}}));
  assert.equal(calls,1);
});
test('same subscription nodes stay fresh for ten minutes and URL changes bypass the node cache',async t=>{
  clearConfigCache();t.mock.timers.enable({apis:['Date'],now:Date.now()});let privateReads=0,subscriptions=0,url='https://subscription.example/one';
  const fetchImpl=async target=>{if(String(target).includes('subscription.example')){subscriptions++;return new Response(subscription);}privateReads++;return Response.json(file('sha',url));};
  try{
    const first=await getNodes(env,fetchImpl);t.mock.timers.tick(61000);assert.equal(await getNodes(env,fetchImpl),first);assert.equal(subscriptions,1);assert.equal(privateReads,2);
    t.mock.timers.tick(NODES_CACHE_TTL_MS-61001);assert.equal(await getNodes(env,fetchImpl),first);assert.equal(subscriptions,1);
    t.mock.timers.tick(2);await getNodes(env,fetchImpl);assert.equal(subscriptions,2);
    url='https://subscription.example/two';await readConfig(env,{fresh:true,fetchImpl});await getNodes(env,fetchImpl);assert.equal(subscriptions,3);
  }finally{t.mock.timers.reset();clearConfigCache();}
});
test('successful administrator save clears even a fresh same-URL node cache',async()=>{
  clearConfigCache();let subscriptions=0,sha='before';const url='https://subscription.example/same';
  const fetchImpl=async(target,options)=>{if(String(target).includes('subscription.example')){subscriptions++;return new Response(subscription);}if(options.method==='PUT'){sha='after';return Response.json({content:{sha}});}return Response.json(file(sha,url));};
  await getNodes(env,fetchImpl);assert.equal(subscriptions,1);
  const result=await writeConfig(env,{subscriptionUrl:url,sha:'before'},fetchImpl);assert.equal(result.sha,'after');assert.equal(subscriptions,2);
  await getNodes(env,fetchImpl);assert.equal(subscriptions,3);clearConfigCache();
});
test('native operation refresh bypasses both the private-file and subscription caches',async()=>{
  clearConfigCache();let privateReads=0,subscriptions=0;
  const fetchImpl=async target=>{if(String(target).includes('subscription.example')){subscriptions++;return new Response(subscription);}privateReads++;return Response.json(file('sha',env.PROXY_SUBSCRIPTION_URL));};
  const first=await getNodes(env,fetchImpl);assert.equal(await getNodes(env,fetchImpl),first);
  const refreshed=await getNodes(env,fetchImpl,{fresh:true});assert.notEqual(refreshed,first);assert.equal(privateReads,2);assert.equal(subscriptions,2);clearConfigCache();
});
