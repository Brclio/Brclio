import { officialTarget, redirectTarget } from './protocol.js';
import { tunnelRequest, safeFailure } from './tunnel.js';

export function relayResponse(body,{status,headers},waitUntil) {
  const rawLength=headers.get('content-length');
  const length=rawLength===null?null:Number(rawLength);
  if(typeof globalThis.FixedLengthStream==='function' && length!==null && Number.isSafeInteger(length) && length>=0) {
    const fixed=new globalThis.FixedLengthStream(length);
    const completion=body.pipeTo(fixed.writable);
    const observed=completion.catch(error=>streamFailure(error,{expectedBytes:length}));
    waitUntil?.(observed);
    return new Response(fixed.readable,{status,headers});
  }
  return new Response(body,{status,headers});
}
export const SEGMENT_BYTES = 4 * 1024 * 1024;
function streamFailure(error,detail={}) {
  const message=String(error?.message||'');
  const code=/不同|发生变化/.test(message)?'artifact_changed':(/未完成|长度|范围/.test(message)?'length_mismatch':(/Illegal invocation|incorrect this/.test(message)?'runtime_binding':(/different request|I\/O|request context/i.test(message)?'io_context':'stream_failed')));
  console.warn(JSON.stringify({event:'proxy_stream_failed',stage:'body',code,...detail}));
}
const forwarded = ['content-type','content-disposition','etag','last-modified','content-length','content-range','accept-ranges'];
function headersFor(upstream) {
  const headers = new Headers({'Cache-Control':'no-store, no-transform', 'X-Content-Type-Options':'nosniff', 'X-Brclio-Route':'subscription-vless'});
  for (const name of forwarded) if (upstream.has(name)) headers.set(name, upstream.get(name));
  return headers;
}
export async function requestWithFailover(target, nodes, options = {}) {
  let last;
  for (const node of nodes.slice(0,3)) {
    if (options.signal?.aborted) throw new Error('下载已取消');
    try {
      const response = await (options.transport || tunnelRequest)(target, node, options);
      if (response.status >= 500 || response.status === 429) { response.close(); await response.body.cancel().catch(()=>{}); throw new Error('代理上游暂不可用'); }
      return response;
    } catch (error) { last = error; if (!options.signal?.aborted) console.warn(JSON.stringify({event:'proxy_attempt_failed', ...safeFailure(error)})); }
  }
  throw new Error('内置代理暂不可用，请关闭内置代理或稍后重试', {cause:last});
}
async function follow(target, nodes, options) {
  let current = target;
  for (let i=0; i<5; i++) {
    const response = await requestWithFailover(current,nodes,options);
    if (![301,302,303,307,308].includes(response.status)) return {...response,target:current};
    const location = response.headers.get('location'); response.close(); await response.body.cancel().catch(()=>{});
    if (!location) throw new Error('下载重定向缺少地址');
    current = redirectTarget(location,current.href);
  }
  throw new Error('下载重定向次数过多');
}
function validateSegment(response, offset, total) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
  if (response.status !== 206 || !match) throw new Error('安装包不支持安全分段下载');
  const start=Number(match[1]), end=Number(match[2]), size=Number(match[3]);
  if (start !== offset || end !== Math.min(size-1, offset+SEGMENT_BYTES-1) || size < 1 || size > 4*1024*1024*1024 || (total !== undefined && size !== total)) throw new Error('安装包分段范围异常');
  if (response.headers.has('content-length') && Number(response.headers.get('content-length')) !== end-start+1) throw new Error('安装包分段长度异常');
  return {total:size,end};
}
export async function relayUpdate(value,nodes, {signal,transport,headerDeadlineMs = 18000,waitUntil} = {}) {
  const initial = officialTarget(value);
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal?.addEventListener('abort',cancel,{once:true});
  if (signal?.aborted) cancel();
  const sourceSignal = signal;
  signal = abort.signal;
  const finish = () => {sourceSignal?.removeEventListener('abort',cancel);};
  const binary = initial.hostname === 'github.com';
  let first;
  const headerTimer = setTimeout(cancel,Math.max(1,headerDeadlineMs));
  try { first = await follow(initial,nodes,{signal,transport,range:binary ? `bytes=0-${SEGMENT_BYTES-1}`:undefined}); } catch(e) { finish(); cancel(); throw e; } finally { clearTimeout(headerTimer); }
  if (!binary || first.status !== 206) {
    const headers = headersFor(first.headers);
    const limit = binary ? SEGMENT_BYTES : 1024*1024;
    let size=0; const reader=first.body.getReader();
    const body = new ReadableStream({async pull(c) {try {const r=await reader.read(); if(r.done){finish();c.close();return;} size+=r.value.length; if(size>limit) throw new Error('更新响应超过允许长度'); c.enqueue(r.value);}catch(e){streamFailure(e,{bytes:size});finish();cancel();first.close();c.error(e);}},cancel(){finish();cancel();first.close();return reader.cancel();}});
    return relayResponse(body,{status:first.status,headers},waitUntil);
  }
  let segment;
  try {segment=validateSegment(first,0);} catch(e) {finish();cancel();first.close();await first.body.cancel().catch(()=>{});throw e;}
  const total=segment.total, etag=first.headers.get('etag');
  const headers=headersFor(first.headers); headers.delete('content-range'); headers.set('content-length',String(total)); headers.delete('accept-ranges');
  let current=first, reader=first.body.getReader(), offset=0, segmentBytes=0;
  const body = new ReadableStream({
    async pull(c) {
      try {
        while(true) {
          const r=await reader.read();
          if(!r.done) {segmentBytes+=r.value.length; if(segmentBytes>segment.end-offset+1) throw new Error('分段下载长度异常'); c.enqueue(r.value);return;}
          if(segmentBytes!==segment.end-offset+1) throw new Error('安装包分段未完成');
          offset=segment.end+1;
          if(offset>=total){finish();c.close();return;}
          current=await requestWithFailover(first.target,nodes,{signal,transport,range:`bytes=${offset}-${Math.min(total-1,offset+SEGMENT_BYTES-1)}`});
          segment=validateSegment(current,offset,total);
          if(etag && current.headers.get('etag')!==etag) throw new Error('安装包在下载期间发生变化');
          reader=current.body.getReader();segmentBytes=0;
        }
      }catch(e){streamFailure(e,{offset,segmentBytes,total});finish();cancel();current.close(); await reader.cancel().catch(()=>{});c.error(e);}
    },cancel(){finish();cancel();current.close();return reader.cancel();}
  });
  return relayResponse(body,{status:200,headers},waitUntil);
}
