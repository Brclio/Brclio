import {test} from 'node:test';
import assert from 'node:assert/strict';
import {releaseSummary, readReleaseResponse} from '../src/releases.js';
const repository='https://github.com/Brclio/Brclio';
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
