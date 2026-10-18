import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ByteReader, readHTTPHead, httpBody, encoder} from '../src/protocol.js';
function chunksReader(chunks) { let index = 0; return new ByteReader(async () => chunks[index++]); }
function textReader(text, split = 16384) {
  const bytes = encoder.encode(text), chunks = [];
  for (let offset = 0; offset < bytes.length; offset += split) chunks.push(bytes.subarray(offset, offset + split));
  return chunksReader(chunks);
}
test('cursor exact reads and readSome preserve byte order across record boundaries', async () => {
  const first = new Uint8Array([1,2,3]), second = new Uint8Array([4,5,6,7]);
  const reader = chunksReader([first,second]);
  const initial = await reader.exact(2); assert.equal(initial.buffer, first.buffer); assert.deepEqual([...initial],[1,2]);
  assert.deepEqual([...await reader.exact(3)],[3,4,5]);
  const tail = await reader.readSome(); assert.equal(tail.buffer,second.buffer); assert.deepEqual([...tail],[6,7]);
  assert.equal(await reader.readSome(),undefined); assert.equal((await reader.exact(0)).length,0);
  await assert.rejects(()=>reader.exact(1),/提前结束/); await assert.rejects(()=>reader.exact(-1),/读取长度/);
});
test('line scanner handles fragmented UTF8 and split CRLF without consuming binary body', async () => {
  const head = encoder.encode('X-Test: café\r\n'), bytes = new Uint8Array(head.length + 4);
  bytes.set(head); bytes.set([0,255,13,10],head.length);
  const reader = chunksReader([bytes.subarray(0,12),bytes.subarray(12,head.length-1),bytes.subarray(head.length-1)]);
  assert.equal(await reader.line(),'X-Test: café'); assert.equal(reader.lastLineContentBytes,head.length-2);
  assert.deepEqual([...await reader.readSome()],[0,255,13,10]);
});
test('line scanner enforces strict CRLF and8192byte limit including terminator', async () => {
  assert.equal((await textReader('a'.repeat(8190)+'\r\n',17).line()).length,8190);
  await assert.rejects(()=>textReader('a'.repeat(8191)+'\r\n',17).line(),/过大/);
  for(const line of ['bare\n','embedded\rCR\r\n','truncated\r']) await assert.rejects(()=>textReader(line,1).line(),/行结束|提前结束/);
});
test('aggregate response-header limit counts UTF8 wire bytes rather than characters', async () => {
  const header='X: '+'é'.repeat(2046)+'x'; assert.equal(encoder.encode(header).length,4096);
  const accepted='HTTP/1.1 200 OK\r\n'+(header+'\r\n').repeat(8)+'\r\n';
  assert.equal((await readHTTPHead(textReader(accepted))).status,200);
  const rejected='HTTP/1.1 200 OK\r\n'+(header+'\r\n').repeat(8)+'Y:x\r\n\r\n';
  await assert.rejects(()=>readHTTPHead(textReader(rejected)),/响应头过大/);
});
test('header scanning avoids per-byte copies of the unread TLS record', async t => {
  const header=encoder.encode('HTTP/1.1 200 OK\r\nX-Test: '+'a'.repeat(1000)+'\r\nContent-Length: 1\r\n\r\n');
  const record=new Uint8Array(16384);record.set(header);record[header.length]=7;
  const original=Uint8Array.prototype.slice;let copied=0;
  t.mock.method(Uint8Array.prototype,'slice',function(start=0,end=this.length){const output=Reflect.apply(original,this,[start,end]);copied+=output.byteLength;return output;});
  const reader=chunksReader([record]);await readHTTPHead(reader);const tail=await reader.readSome();
  assert.equal(tail.buffer,record.buffer);assert.equal(tail[0],7);assert.ok(copied<=record.length*2,`unexpected copied bytes:${copied}`);
});
test('chunked body exact reads retain split framing and bounded trailers',async()=>{
  const reader=textReader('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\nX: é\r\n\r\n',1);
  const head=await readHTTPHead(reader);assert.equal(await new Response(httpBody(reader,head.headers,()=>{})).text(),'abcde');
  const invalid=textReader('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\na\r\n0\r\n\r\n',1);
  const invalidHead=await readHTTPHead(invalid);await assert.rejects(()=>new Response(httpBody(invalid,invalidHead.headers,()=>{})).text(),/行结束/);
});
