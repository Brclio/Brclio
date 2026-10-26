'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{X509Certificate}=require('node:crypto');
const {createFixtureCertificateVerifier,sanitizeFixtureTLSState}=require('./native-proxy-tls-fixture.cjs');
const originPEM=fs.readFileSync(path.join(__dirname,'fixtures/update-proxy-tls/origin.pem'),'utf8');
const origin=new X509Certificate(originPEM);
const relay=new X509Certificate(fs.readFileSync(path.join(__dirname,'fixtures/update-proxy-tls/relay.pem')));

test('offline native TLS pin requires both the exact leaf and the requested hostname',()=>{
 for(const [name,expected,hostname,data,code,hostnameMatched,fingerprintMatched,result] of[
  ['valid',origin,'github.com',originPEM,0,true,true,'accepted'],
  ['wrong hostname',origin,'forbidden.example',originPEM,-200,false,true,'hostname-mismatch'],
  ['different pinned leaf',relay,'github.com',originPEM,-202,true,false,'fingerprint-mismatch'],
  ['malformed certificate',origin,'github.com','invalid-certificate',-207,false,false,'invalid-certificate']
 ]){
  const verifier=createFixtureCertificateVerifier(expected),callbacks=[];
  assert.deepEqual(verifier.snapshot(),{callbackCount:0,hostnameMatched:false,fingerprintMatched:false,result:'not-called'});
  verifier.verify({hostname,certificate:{data}},value=>callbacks.push(value));
  assert.deepEqual(callbacks,[code],name);
  assert.deepEqual(verifier.snapshot(),{callbackCount:1,hostnameMatched,fingerprintMatched,result},name);
 }
 const verifier=createFixtureCertificateVerifier(origin);
 verifier.verify({hostname:'github.com',certificate:{data:originPEM}},()=>{});
 verifier.verify({hostname:'forbidden.example',certificate:{data:originPEM}},()=>{});
 assert.deepEqual(verifier.snapshot(),{callbackCount:2,hostnameMatched:false,fingerprintMatched:true,result:'hostname-mismatch'});
});

test('offline TLS diagnostics accept only fixed classifications, counts and booleans',()=>{
 const safe={callbackCount:1,hostnameMatched:true,fingerprintMatched:true,result:'accepted'};
 assert.deepEqual(sanitizeFixtureTLSState({...safe,certificate:originPEM,url:'https://private.example',token:'private-token',body:'private-body'}),safe);
 for(const value of[null,{},...[-1,0.5,NaN,Infinity].map(callbackCount=>({...safe,callbackCount})),
  {...safe,hostnameMatched:'true'},{...safe,fingerprintMatched:1},{...safe,result:'private-error-text'}]){
  assert.equal(sanitizeFixtureTLSState(value),null);
 }
});
