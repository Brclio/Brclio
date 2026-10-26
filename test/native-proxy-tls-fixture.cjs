'use strict';

// Offline fixture only. Never install this verifier in the application.
const {X509Certificate}=require('node:crypto');
const results=new Set(['not-called','accepted','hostname-mismatch','fingerprint-mismatch','invalid-certificate']);

function sanitizeFixtureTLSState(value){
 if(!value||!Number.isSafeInteger(value.callbackCount)||value.callbackCount<0||
  typeof value.hostnameMatched!=='boolean'||typeof value.fingerprintMatched!=='boolean'||!results.has(value.result))return null;
 return{callbackCount:value.callbackCount,hostnameMatched:value.hostnameMatched,fingerprintMatched:value.fingerprintMatched,result:value.result};
}

function createFixtureCertificateVerifier(expectedCertificate){
 const state={callbackCount:0,hostnameMatched:false,fingerprintMatched:false,result:'not-called'};
 return{
  verify(request,callback){
   state.callbackCount++;state.hostnameMatched=false;state.fingerprintMatched=false;
   let code=-207;state.result='invalid-certificate';
   try{
    const received=new X509Certificate(request.certificate.data);
    state.hostnameMatched=Boolean(received.checkHost(request.hostname));
    state.fingerprintMatched=received.fingerprint256===expectedCertificate.fingerprint256;
    state.result=!state.hostnameMatched?'hostname-mismatch':!state.fingerprintMatched?'fingerprint-mismatch':'accepted';
    code=!state.hostnameMatched?-200:state.fingerprintMatched?0:-202;
   }catch{ /* Diagnostics never retain provider data or exception messages. */ }
   callback(code);
  },
  snapshot:()=>sanitizeFixtureTLSState(state)
 };
}

module.exports={createFixtureCertificateVerifier,sanitizeFixtureTLSState};
