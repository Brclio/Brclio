import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clientProxyConfiguration, handleClientConfiguration} from '../src/client-config.js';
import {parseSubscription, validateDialAddress} from '../src/protocol.js';
const uuid='00112233-4455-6677-8899-aabbccddeeff';
const node={uuid,host:'vpn.example.com',port:443,path:'/tunnel?ed=2048',dialAddress:'104.17.1.1'};
const candidate=i=>({...node,host:`node${i}.vpn.example.com`});

test('native configuration v1 returns every candidate up to16 and only seven necessary node fields',()=>{
  const result=clientProxyConfiguration(Array.from({length:16},(_,i)=>({...candidate(i),subscriptionUrl:'private-subscription',GITHUB_TOKEN:'private-token'})));
  assert.equal(result.version,1);assert.equal(result.ttlSeconds,600);assert.equal(result.nodes.length,16);
  for(const output of result.nodes){assert.deepEqual(Object.keys(output).sort(),['dialAddress','host','path','port','servername','uuid','wsHost']);assert.equal(output.host,output.servername);assert.equal(output.host,output.wsHost);}
  assert.ok(!JSON.stringify(result).includes('private-'));
  assert.throws(()=>clientProxyConfiguration(Array.from({length:17},(_,i)=>candidate(i))),/too_many/);
  assert.throws(()=>clientProxyConfiguration(Array.from({length:16},(_,i)=>({...candidate(i),path:'/'+'x'.repeat(2047)}))),/too_large/);
  assert.equal(clientProxyConfiguration([node,node]).nodes.length,1);
  const routes=clientProxyConfiguration(Array.from({length:16},(_,i)=>({...node,dialAddress:`104.17.1.${i+1}`})));
  assert.equal(routes.nodes.length,16);assert.equal(new Set(routes.nodes.map(n=>n.dialAddress)).size,16);
  for(const route of routes.nodes)assert.equal(route.host,node.host);
});

test('dial addresses are canonical public IPv4 or strict public DNS, independent of the TLS name',()=>{
  for(const address of ['1.1.1.1','8.8.8.8','104.17.1.1','223.255.255.254','dial.example.com','fd.example.com'])assert.equal(validateDialAddress(address),address);
  for(const address of ['0.1.2.3','10.1.2.3','100.64.0.1','100.127.255.254','127.0.0.1','169.254.1.1','172.16.1.1','172.31.255.254','192.0.0.1','192.0.2.1','192.88.99.1','192.168.1.1','198.18.0.1','198.19.255.255','198.51.100.1','203.0.113.1','224.0.0.1','240.0.0.1','255.255.255.255','104.017.1.1','1.1.1.256','1.1.1','1.1.1.1.1','0x68000101','[::1]','::1','VPN.example.com','vpn.local','vpn.localhost','vpn.internal','vpn.invalid','vpn.test','vpn.example','vpn.onion','vpn.lan','vpn.home','home.arpa','vpn.home.arpa','bad..example.com','-bad.example.com'])assert.throws(()=>validateDialAddress(address),undefined,address);
  assert.throws(()=>clientProxyConfiguration([{...node,dialAddress:undefined}]),/no_supported/);
  assert.equal(clientProxyConfiguration([{...node,dialAddress:'dial.example.com'}]).nodes[0].servername,node.host);
});

test('native nodes reject private/IP destinations, malformed paths, unsupported ports and insecure settings',()=>{
  for(const change of [{host:'127.0.0.1'},{host:'10.0.0.1'},{host:'[::1]'},{host:'vpn.local'},{host:'vpn.internal'},{host:'bad..example.com'},{port:80},{path:'//other.example.com'},{path:'/bad\r\nHeader:x'},{path:'/bad%xx'},{path:'/x#fragment'},{servername:'other.example.com'},{wsHost:'other.example.com'},{'skip-cert-verify':true},{insecure:true}])assert.throws(()=>clientProxyConfiguration([{...node,...change}]),/no_supported/);
});

test('subscription parser excludes enabled insecure flags in YAML and VLESS URIs',()=>{
  const proxy={type:'vless',uuid,tls:true,network:'ws',port:443,servername:node.host,'ws-opts':{path:node.path,headers:{Host:node.host}}};
  for(const flag of ['skip-cert-verify','skipCertVerify','allowInsecure','insecure']){
    assert.throws(()=>parseSubscription(JSON.stringify({proxies:[{...proxy,[flag]:true}]})));
    assert.equal(parseSubscription(JSON.stringify({proxies:[{...proxy,[flag]:false}]})).length,1);
  }
  assert.throws(()=>parseSubscription(`vless://${uuid}@vpn.example.com:443?security=tls&type=ws&sni=vpn.example.com&allowInsecure=1`));
  assert.equal(parseSubscription(`vless://${uuid}@vpn.example.com:443?security=tls&type=ws&sni=vpn.example.com&allowInsecure=0`).length,1);
});

test('each native configuration request checks fresh private config, opts into bounded validated subscription reuse, and is no-store and rate limited',async()=>{
  const env={ADMIN_PASSWORD:'private-admin',GITHUB_TOKEN:'private-token',PROXY_SUBSCRIPTION_URL:'https://private.example/sub'};let calls=0;
  const dependencies={getNodes:async(received,fetchImpl,options)=>{calls++;assert.equal(received,env);assert.equal(fetchImpl,undefined);assert.deepEqual(options,{fresh:true,reuseValidatedSubscription:true});return[node];}};
  const request=()=>new Request('https://tools.brclio.com/api/client/update-proxy',{headers:{'CF-Connecting-IP':'native-config-test'}});
  for(let i=0;i<2;i++){const response=await handleClientConfiguration(request(),env,dependencies);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('access-control-allow-origin'),null);const body=await response.text();for(const secret of Object.values(env))assert.ok(!body.includes(secret));}
  assert.equal(calls,2);
  const limited=await handleClientConfiguration(request(),{...env,CLIENT_CONFIG_LIMITER:{limit:async({key})=>{assert.equal(key,'native-config-test');return{success:false};}}},dependencies);assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'60');assert.equal(calls,2);
  const failure=await handleClientConfiguration(request(),env,{getNodes:async()=>{throw Error('private-token');}});assert.equal(failure.status,502);assert.ok(!(await failure.text()).includes('private-token'));
  const excess=await handleClientConfiguration(request(),env,{getNodes:async()=>Array.from({length:17},(_,index)=>candidate(index))});assert.equal(excess.status,502);assert.equal((await excess.json()).code,'proxy_configuration_unsupported');
  const post=await handleClientConfiguration(new Request(request().url,{method:'POST'}),env,dependencies);assert.equal(post.status,405);assert.equal(calls,2);
});
