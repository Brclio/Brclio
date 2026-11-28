'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('./terminal/snippet-model.js');
const { create } = require('./terminal/sync-partitions.js');
const { store } = require('./terminal/connection.js');
const { portable } = require('./terminal/sync-model.js');

const plain = { id: 'existing', kind: 'snippet', name: '路径', text: 'echo {{path}}' };
test('existing literal snippets, package search and variable substitution preserve their content', () => {
  const packaged = model.normalize({ ...plain, id: 'second', package: 'ops', template: true, text: '{{目录}} {{key}} {{目录}}' });
  const items = model.read({ getItem: () => JSON.stringify([plain, packaged]) });
  assert.deepEqual(items[0], plain);
  assert.deepEqual(model.variables(packaged.text), ['目录', 'key']);
  assert.equal(model.fill(packaged.text, new Map([['目录', '$& (literal)'], ['key', '{{目录}}']])), '$& (literal) {{目录}} $& (literal)');
  assert.deepEqual(model.search(items, 'OPS key', null), [packaged]);
  assert.deepEqual(model.search(items, '', ''), [plain]);
  assert.throws(() => model.normalize({ ...plain, package: 'Ops\nOther' }));
  assert.throws(() => model.fill('{{x}}'.repeat(20), new Map([['x','x'.repeat(2048)]])));
});

test('saving a team snippet preserves an existing local item, uses a private ID and can be retried', () => {
  const map = new Map(), storage = {getItem:k => map.get(k),setItem:(k,v) => map.set(k,v)};
  const original = {...plain,package:'ops',id:'taken'};
  model.store(storage,[original]);
  const shared = {...original,id:'shared',text:'new text',template:true};
  const copy = model.addCopy(storage,shared);
  assert.notEqual(copy.id,shared.id);
  assert.equal(copy.name,'路径（团队副本 1）');
  assert.deepEqual(model.addCopy(storage,shared),copy);
  assert.deepEqual(model.read(storage),[original,copy]);
  assert.throws(() => model.addCopy(storage,{...shared,kind:'note'}));
});

test('guest moves remap startup snippet IDs on collision and preserve distinct packages and template modes', () => {
  const map = new Map(), raw = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
  const partitions = create(raw), storage = partitions.storage, hosts = store(storage);
  partitions.activate(null);
  storage.setItem(model.key, JSON.stringify([{ ...plain, package: 'qa', template: true }]));
  hosts.save({ name:'guest', host:'guest.invalid', startupSnippet: plain.id });
  partitions.activate('A');
  storage.setItem(model.key, JSON.stringify([plain]));
  hosts.save({ name:'home', host:'home.invalid', startupSnippet: plain.id });
  partitions.moveUnbound();
  const list = model.read(storage);
  assert.equal(list.length, 2);
  assert.notEqual(list[0].id, list[1].id);
  assert.deepEqual(hosts.all().map(h => list.find(s => s.id === h.startupSnippet)?.package || null), [null,'qa']);
  assert.ok(portable({hosts:hosts.all(), forwards:[]}).hosts.every(h => !('startupSnippet' in h)));
  partitions.activate('B'); assert.deepEqual(model.read(storage), []);
});
