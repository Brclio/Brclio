import {test} from 'node:test';
import assert from 'node:assert/strict';
import {releaseSummary, readReleaseResponse, getOfficialRelease, clearReleaseCache, latestReleaseURL, releaseFailureDetails} from '../src/releases.js';
const repository='https://github.com/Brclio/Brclio';
test('configured release reads use only the existing program App scope at the fixed public endpoint and remain cached', async () => {
  clearReleaseCache();
  const env={GITHUB_APP_ID:'synthetic',GITHUB_APP_INSTALLATION_ID:'synthetic',GITHUB_APP_PRIVATE_KEY:'synthetic',
    GITHUB_PROGRAM_DATA_REPOSITORY:'Fixture/Program',GITHUB_DATA_REPOSITORY:'Fixture/Accounts'};
  let tokens=0,reads=0;
  const fetchImpl=async(url,options)=>{
    reads++; assert.equal(url,latestReleaseURL);assert.equal(options.method,undefined);assert.equal(options.redirect,'manual');
    assert.equal(options.headers.Authorization,'Bearer synthetic-installation-token');
    return Response.json(releaseFixture());
  };
  const tokenProvider=async(received,scope,fetch)=>{tokens++;assert.equal(received,env);assert.equal(scope,'Fixture/Program');assert.equal(fetch,fetchImpl);return 'synthetic-installation-token';};
  assert.equal((await getOfficialRelease(env,fetchImpl,tokenProvider)).summary.version,'0.1.8');
  assert.equal((await getOfficialRelease(env,fetchImpl,tokenProvider)).summary.version,'0.1.8');
  assert.equal(tokens,1);assert.equal(reads,1);clearReleaseCache();
});
test('configured App failures cannot silently select account scope, anonymous reads or sensitive diagnostics', async () => {
  clearReleaseCache();let reads=0;
  await assert.rejects(getOfficialRelease({GITHUB_APP_ID:'synthetic',GITHUB_APP_INSTALLATION_ID:'synthetic',GITHUB_APP_PRIVATE_KEY:'synthetic',
    GITHUB_PROGRAM_DATA_REPOSITORY:'Fixture/Program',GITHUB_DATA_REPOSITORY:'Fixture/Accounts'},async()=>{reads++;},async(_env,scope)=>{
    assert.equal(scope,'Fixture/Program');throw new Error('private provider details');
  }),error=>{assert.deepEqual(releaseFailureDetails(error),{code:'release_auth_unavailable'});return true;});
  assert.equal(reads,0);clearReleaseCache();
});
test('release diagnostics expose only fixed classifications and bounded HTTP statuses', async () => {
  for (const [response, expected] of [
    [new Response('private upstream detail', {status: 403, headers: {'x-ratelimit-remaining':'0'}}), {code:'release_upstream_rate_limited',upstreamStatus:403}],
    [new Response('private upstream detail', {status: 503}), {code:'release_upstream_status',upstreamStatus:503}],
    [new Response('not JSON', {status: 200}), {code:'release_invalid_json'}]
  ]) {
    clearReleaseCache();
    await assert.rejects(getOfficialRelease({}, async () => response), error => {
      assert.deepEqual(releaseFailureDetails(error), expected); return true;
    });
  }
  for (const name of ['TimeoutError', 'TypeError']) {
    clearReleaseCache();
    await assert.rejects(getOfficialRelease({}, async () => {throw Object.assign(new Error('private credential'), {name});}), error => {
      assert.deepEqual(releaseFailureDetails(error), {code:name === 'TimeoutError' ? 'release_fetch_timeout' : 'release_fetch_failed'}); return true;
    });
  }
  assert.deepEqual(releaseFailureDetails({code:'secret-value',message:'private credential',upstreamStatus:403}), {code:'release_unknown'});
  assert.deepEqual(releaseFailureDetails({code:'release_upstream_status',upstreamStatus:999}), {code:'release_upstream_status'});
  clearReleaseCache();
});
export function releaseFixture() {
  return {tag_name:'v0.1.8',draft:false,prerelease:false,published_at:'2026-10-17T00:00:00Z',html_url:repository+'/releases/tag/v0.1.8',body:'private-unrecognized-field',assets:[
    {name:'SHA256SUMS.txt',size:300,browser_download_url:repository+'/releases/download/v0.1.8/SHA256SUMS.txt'},
    ...['mac-arm64.dmg','mac-x64.dmg','windows-x64.exe','android.apk'].map(suffix=>({name:'Brclio-0.1.8-'+suffix,size:4096,browser_download_url:repository+'/releases/download/v0.1.8/Brclio-0.1.8-'+suffix}))
  ]};
}
test('public release summary exposes only official stable installers and their checksum manifest',()=>{
  const result=releaseSummary(releaseFixture());
  assert.deepEqual(Object.keys(result),['version','tag','publishedAt','releaseURL','assets']);
  assert.equal(result.version,'0.1.8');assert.equal(result.tag,'v0.1.8');assert.equal(result.publishedAt,'2026-10-17T00:00:00.000Z');
  assert.deepEqual(result.assets.map(asset=>asset.platform),['mac-arm64','mac-x64','windows-x64','android']);
  assert.ok(result.assets.every(asset=>asset.checksumURL===repository+'/releases/download/v0.1.8/SHA256SUMS.txt'));
  assert.ok(!JSON.stringify(result).includes('private-unrecognized-field'));
});
test('release summary rejects prerelease, draft, wrong repository, tag mismatch and ambiguous downloads',()=>{
  const mutations=[
    release=>{release.prerelease=true;},release=>{release.draft=true;},release=>{release.tag_name='v0.1.8-beta.1';},
    release=>{release.html_url='https://github.com/elsewhere/Brclio/releases/tag/v0.1.8';},
    release=>{release.assets[1].browser_download_url=repository+'/releases/download/v0.1.7/'+release.assets[1].name;},
    release=>{release.assets[1].browser_download_url='https://evil.example/installer';},
    release=>{release.assets.push({...release.assets[1]});},release=>{release.assets.shift();},
    release=>{release.assets[0].size=65537;},release=>{release.assets[1].size=0;},release=>{release.published_at='invalid';}
  ];
  for(const change of mutations){const release=releaseFixture();change(release);assert.throws(()=>releaseSummary(release));}
});
test('release response bounds and cancels malformed or oversized upstream metadata',async()=>{
  assert.equal((await readReleaseResponse(Response.json(releaseFixture()))).version,'0.1.8');
  let canceled=false;
  const body=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(1024*1024+1));},cancel(){canceled=true;}});
  await assert.rejects(readReleaseResponse(new Response(body)),/too_large/);assert.equal(canceled,true);
  await assert.rejects(readReleaseResponse(new Response('upstream-private-message',{status:403})),/unavailable/);
});
test('public release reads never use a legacy personal token or a raw private key as authorization', async () => {
  clearReleaseCache(); let calls = 0;
  const result = await getOfficialRelease({GITHUB_TOKEN: 'legacy-personal-token', GITHUB_APP_PRIVATE_KEY: 'private-key-not-for-public-releases'}, async (url, options) => {
    calls++; assert.equal(url, latestReleaseURL); assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'manual'); return Response.json(releaseFixture());
  });
  assert.equal(result.summary.version, '0.1.8'); assert.equal(calls, 1); clearReleaseCache();
});
