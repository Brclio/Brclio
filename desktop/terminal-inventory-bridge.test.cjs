'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {bridge} = require('./terminal/inventory-bridge.cjs');

test('the opt-in inventory bridge accepts only authenticated loopback requests and stops immediately', async t => {
  const events = [];
  const server = bridge(async message => { events.push(message); return {status:201,data:{ok:true}}; });
  t.after(server.stop);
  assert.equal(server.state(),null);
  const {url,token} = await server.start();
  assert.match(url,/^http:\/\/127\.0\.0\.1:[0-9]+$/);
  const headers = {authorization:'Bearer ' + token};
  assert.equal((await fetch(url + '/v1/inventory')).status,401);
  assert.equal((await fetch(url + '/v1/inventory',{headers:{...headers,origin:'https://example.test'}})).status,403);
  assert.equal((await fetch(url + '/v1/host/test',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{"address":"host.example.test"}'})).status,201);
  assert.deepEqual(events,[{op:'create-host',name:'test',body:{address:'host.example.test'}}]);
  assert.equal((await fetch(url + '/v1/terminal',{method:'POST',headers})).status,404);
  server.stop();
  await assert.rejects(fetch(url + '/v1/inventory',{headers}));
  const second = await server.start();
  assert.notEqual(token,second.token);
});
