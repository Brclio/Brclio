import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {readConfig as readConfigImpl,writeConfig as writeConfigImpl,getNodes as getNodesImpl,clearConfigCache,CONFIG_PATH,NODES_CACHE_TTL_MS} from '../src/config.js';
const installationToken = 'fixture-installation-token';
const tokenProvider = async (_env, repository) => { assert.equal(repository, 'BrclioData/BrclioData'); return installationToken; };
const readConfig = (env, options) => readConfigImpl(env, {...options, tokenProvider});
const writeConfig = (env, input, fetchImpl) => writeConfigImpl(env, input, fetchImpl, {tokenProvider});
const getNodes = (env, fetchImpl, options) => getNodesImpl(env, fetchImpl, {...options, tokenProvider});
const env={ADMIN_EMAIL:'admin@example.com',GITHUB_DATA_REPOSITORY:'BrclioData/BrclioUserData',GITHUB_PROGRAM_DATA_REPOSITORY:'BrclioData/BrclioData',PROXY_SUBSCRIPTION_URL:'https://subscription.example/sub'};
const subscription=JSON.stringify({proxies:[{type:'vless',uuid:'00112233-4455-6677-8899-aabbccddeeff',tls:true,network:'ws',servername:'vpn.example.com',port:443,'ws-opts':{path:'/tunnel',headers:{Host:'vpn.example.com'}}}]});
const documentFile=(sha,data)=>{const bytes=Buffer.from(JSON.stringify(data));return{sha,size:bytes.length,encoding:'base64',content:bytes.toString('base64')};};
const file=(sha,url)=>documentFile(sha,{subscriptionUrl:url,updatedAt:'2026-10-18T00:00:00.000Z'});
test('missing config uses deployment env; GitHub authorization never enters stored config',async()=>{
  clearConfigCache();const response=await readConfig(env,{fresh:true,fetchImpl:async(url,init)=>{assert.equal(url,`https://api.github.com/repos/${env.GITHUB_PROGRAM_DATA_REPOSITORY}/contents/${CONFIG_PATH}`);assert.equal(init.headers.Authorization,'Bearer ' + installationToken);return new Response('',{status:404});}});
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
    assert.equal(url,`https://api.github.com/repos/${env.GITHUB_PROGRAM_DATA_REPOSITORY}/contents/${CONFIG_PATH}`);
    if(init.method==='PUT'){put=JSON.parse(init.body);return Response.json({content:{sha:'new-sha'}});}
    return Response.json(file('old','https://subscription.example/old'));
  });
  assert.equal(result.sha,'new-sha');assert.equal(result.compatibleNodes,1);assert.equal(put.sha,'old');
  const stored=JSON.parse(Buffer.from(put.content,'base64').toString());assert.equal(stored.subscriptionUrl,'https://subscription.example/new');assert.equal(stored.updatedBy,env.ADMIN_EMAIL);assert.ok(!JSON.stringify(stored).includes(installationToken));
});
test('missing or invalid program repository cannot fall back to the account repository or a cached config',async()=>{
  clearConfigCache();let calls=0;
  const fetchImpl=async()=>{calls++;return new Response('',{status:404});};
  await readConfig(env,{fetchImpl});assert.equal(calls,1);
  for(const repository of [undefined,'','../BrclioData','owner/..','owner/repo/extra',42]){
    const missing={...env,GITHUB_PROGRAM_DATA_REPOSITORY:repository};
    await assert.rejects(readConfig(missing,{fetchImpl}),/程序资料仓库尚未配置/);
    await assert.rejects(writeConfig(missing,{subscriptionUrl:env.PROXY_SUBSCRIPTION_URL,sha:null},fetchImpl),/程序资料仓库尚未配置/);
  }
  assert.equal(calls,1);clearConfigCache();
});
test('saving version1 and legacy config preserves private unknown nested fields without returning them publicly',async()=>{
  for(const version of [1,undefined]){
    clearConfigCache();
    const original={...(version===undefined?{}:{version}),subscriptionUrl:'https://subscription.example/old',updatedAt:'2026-10-18T00:00:00.000Z',updatedBy:'old-admin@example.com',future:{nested:{opaque:'private-future-setting',enabled:false},values:[{keep:7},'unchanged']},futureFlag:false};
    let saved;
    const fetchImpl=async(url,options)=>{
      if(String(url).includes('subscription.example'))return new Response(subscription);
      if(options.method==='PUT'){saved=JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64').toString());return Response.json({content:{sha:'new-sha'}});}
      return Response.json(documentFile('old-sha',original));
    };
    const publicConfig=await readConfig(env,{fresh:true,fetchImpl});
    assert.deepEqual(publicConfig,{subscriptionUrl:original.subscriptionUrl,sha:'old-sha',updatedAt:original.updatedAt});
    assert.equal(Object.getOwnPropertySymbols(publicConfig).length,0);assert.ok(!JSON.stringify(publicConfig).includes('private-future-setting'));
    const result=await writeConfig(env,{subscriptionUrl:'https://subscription.example/new',sha:'old-sha'},fetchImpl);
    assert.equal(result.sha,'new-sha');assert.equal(saved.version,1);assert.equal(saved.subscriptionUrl,'https://subscription.example/new');
    assert.equal(saved.updatedBy,env.ADMIN_EMAIL);assert.notEqual(saved.updatedAt,original.updatedAt);
    assert.deepEqual(saved.future,original.future);assert.equal(saved.futureFlag,false);
  }
  clearConfigCache();
});
test('non-object config and unsupported versions fail closed before subscription access or any write',async()=>{
  const invalid=[null,[],true,42,'not-an-object',... [0,2,'1',null].map(version=>({version,subscriptionUrl:env.PROXY_SUBSCRIPTION_URL,future:{mustStay:true}}))];
  let puts=0,subscriptions=0;
  for(const document of invalid){
    clearConfigCache();const fetchImpl=async(url,options)=>{
      if(options.method==='PUT')puts++;
      if(String(url).includes('subscription.example')){subscriptions++;return new Response(subscription);}
      return Response.json(documentFile('old-sha',document));
    };
    await assert.rejects(readConfig(env,{fresh:true,fetchImpl}),/私有配置(?:格式无效|版本不受支持)/);
    await assert.rejects(writeConfig(env,{subscriptionUrl:env.PROXY_SUBSCRIPTION_URL,sha:'old-sha'},fetchImpl),/私有配置(?:格式无效|版本不受支持)/);
  }
  assert.equal(puts,0);assert.equal(subscriptions,0);clearConfigCache();
});
test('a preserved document that exceeds the read limit after an edit is not written',async()=>{
  clearConfigCache();const original={version:1,subscriptionUrl:'https://subscription.example/old',future:'x'.repeat(16250)};
  const current=documentFile('old-sha',original);assert.ok(current.size<=16384);let puts=0;
  const fetchImpl=async(url,options)=>{
    if(String(url).includes('subscription.example'))return new Response(subscription);
    if(options.method==='PUT'){puts++;return Response.json({content:{sha:'should-not-be-written'}});}
    return Response.json(current);
  };
  await assert.rejects(writeConfig(env,{subscriptionUrl:'https://subscription.example/new',sha:'old-sha'},fetchImpl),/私有配置过大/);
  assert.equal(puts,0);clearConfigCache();
});
test('program repository selects both config and node caches independently of account storage',async()=>{
  clearConfigCache();const second={...env,GITHUB_PROGRAM_DATA_REPOSITORY:'BrclioData/AnotherProgramData'};let subscriptions=0;const privateReads=[];
  const provider=async(_env,repository)=>{assert.ok([env.GITHUB_PROGRAM_DATA_REPOSITORY,second.GITHUB_PROGRAM_DATA_REPOSITORY].includes(repository));return installationToken;};
  const fetchImpl=async url=>{
    if(String(url).includes('subscription.example')){subscriptions++;return new Response(subscription);}
    privateReads.push(url);return Response.json(file(String(privateReads.length),env.PROXY_SUBSCRIPTION_URL));
  };
  const first=await getNodesImpl(env,fetchImpl,{tokenProvider:provider});
  const secondResult=await getNodesImpl(second,fetchImpl,{tokenProvider:provider});
  assert.notEqual(secondResult,first);assert.equal(subscriptions,2);
  assert.deepEqual(privateReads,[env,second].map(value=>`https://api.github.com/repos/${value.GITHUB_PROGRAM_DATA_REPOSITORY}/contents/${CONFIG_PATH}`));
  assert.equal(await getNodesImpl({...second,GITHUB_DATA_REPOSITORY:'OtherOwner/AccountOnly'},fetchImpl,{tokenProvider:provider}),secondResult);
  assert.equal(privateReads.length,2);assert.equal(subscriptions,2);clearConfigCache();
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
test('a failed fresh subscription still reads current GitHub config and never returns previously cached nodes',async t=>{
  clearConfigCache();t.mock.timers.enable({apis:['Date','setTimeout'],now:50000});
  let privateReads=0,subscriptions=0,unavailable=false;
  const fetchImpl=async target=>{
    if(String(target).includes('subscription.example')){subscriptions++;return unavailable?new Response('',{status:400}):new Response(subscription);}
    privateReads++;return Response.json(file('sha',env.PROXY_SUBSCRIPTION_URL));
  };
  try{
    const cached=await getNodes(env,fetchImpl);assert.equal(cached.length,1);unavailable=true;
    const rejected=assert.rejects(getNodes(env,fetchImpl,{fresh:true}),/无法读取代理订阅/);
    await setImmediate();t.mock.timers.tick(100);await rejected;
    assert.equal(privateReads,2);assert.equal(subscriptions,3);
  }finally{t.mock.timers.reset();clearConfigCache();}
});

test('native fresh reads observe changed subscription content at the same URL and SHA without secondary subscription fetches',async()=>{
  clearConfigCache();let privateReads=0,subscriptions=0,currentPath='/before',unavailable=false;
  const fetchImpl=async target=>{
    if(String(target).includes('subscription.example')){
      subscriptions++;
      if(unavailable)return new Response('',{status:503});
      const document=JSON.parse(subscription);document.proxies[0]['ws-opts'].path=currentPath;return Response.json(document);
    }
    privateReads++;return Response.json(file('same-sha',env.PROXY_SUBSCRIPTION_URL));
  };
  const options={fresh:true,subscriptionAttempts:1};
  assert.equal((await getNodes(env,fetchImpl,options))[0].path,'/before');
  currentPath='/after';assert.equal((await getNodes(env,fetchImpl,options))[0].path,'/after');
  assert.equal(privateReads,2);assert.equal(subscriptions,2);
  unavailable=true;await assert.rejects(getNodes(env,fetchImpl,options),/无法读取代理订阅/);
  assert.equal(privateReads,3);assert.equal(subscriptions,3);clearConfigCache();
});
