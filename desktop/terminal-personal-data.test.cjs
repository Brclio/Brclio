'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('./terminal/sync-partitions.js');
const { store } = require('./terminal/arrangements.js');

test('unassociated notes, layouts and dynamic profile bindings remain local until a confirmed move and are isolated across accounts', () => {
  const map = new Map();
  const storage = { getItem: key => map.get(key) ?? null, setItem: (key,v) => map.set(key,v), removeItem: key => map.delete(key) };
  const partitions = create(storage);
  const notes = 'brclio.terminal.snippets.v1', rules = 'brclio.terminal.profile-rules.v1', dynamic = 'brclio.terminal.dynamic-import.v1';
  const snippet = { id:'same-id', name:'ops', kind:'note', text:'guest note' };
  const preset = {guid:'legacy-id', name:'build-host', colors:{} };
  const rule = { host:'internal.test', path:'/fixture', profile:'review' };
  const layout = { tabs:[{ name:'target.ref', root:{ profile:'bash', cwd:'/old/work', shellIntegration:false }, activePane:0 }], activeTab:0 };
  const scoped = partitions.storage;
  partitions.activate(null);
  const profiles = 'brclio.terminal.profiles.v1';
  scoped.setItem(profiles,JSON.stringify({active:'review',presets:[{name:'review',cwd:'/unassociated'}]}));
  store(scoped).save('workspace',layout);
  scoped.setItem(notes,JSON.stringify([snippet]));
  scoped.setItem(dynamic,JSON.stringify([preset]));
  scoped.setItem(rules,JSON.stringify([rule]));

  partitions.lock();
  assert.equal(scoped.getItem(notes),null);
  partitions.activate('alice');
  assert.equal(partitions.hasUnbound(),true);
  assert.deepEqual(store(scoped).names(),[]);
  scoped.setItem(notes,JSON.stringify([{...snippet,text:'account note'}]));
  scoped.setItem(dynamic,JSON.stringify([{...preset,name:'account name'}]));
  scoped.setItem(profiles,JSON.stringify({active:'review',presets:[{name:'review',cwd:'/account'}]}));
  store(scoped).save('workspace',{...layout, tabs:[{...layout.tabs[0],name:'existing'}]});
  partitions.moveUnbound();
  assert.equal(partitions.hasUnbound(),false);
  assert.deepEqual(store(scoped).names(),['workspace','workspace (本机 1)']);
  const savedNotes = JSON.parse(scoped.getItem(notes));
  assert.equal(new Set(savedNotes.map(item => item.id)).size,2);
  assert.deepEqual(savedNotes.map(item => item.text),['account note','guest note']);
  assert.deepEqual(JSON.parse(scoped.getItem(rules)),[{...rule,profile:'review (本机 1)'}]);
  const movedProfiles = JSON.parse(scoped.getItem(profiles));
  assert.equal(movedProfiles.active,'review');
  assert.equal(movedProfiles.presets[1].cwd,'/unassociated');
  assert.equal(new Set(JSON.parse(scoped.getItem(dynamic)).map(item => item.guid)).size,2);
  partitions.activate('bob');
  assert.equal(scoped.getItem(notes),null);
  assert.deepEqual(store(scoped).names(),[]);
  partitions.activate(null);
  assert.equal(scoped.getItem(dynamic),null);
  partitions.activate('alice');
  assert.deepEqual(JSON.parse(scoped.getItem(notes)),savedNotes);
});

test('a migration over capacity leaves original notes and destination untouched', () => {
  const map = new Map();
  const raw = { getItem:key => map.get(key)??null, setItem:(key,v) => map.set(key,v), removeItem:key => map.delete(key) };
  const p = create(raw);
  const key = 'brclio.terminal.snippets.v1';
  const prior = JSON.stringify([{name:'other',id:'one',text:'data',kind:'note'}]);
  raw.setItem(key,prior);
  p.activate('one');
  const full = JSON.stringify(Array.from({ length:200 },(_,i) => ({id:'i'+i,name:'user'+i,kind:'note',text:'contents'})));
  p.storage.setItem(key,full);
  assert.throws(() => p.moveUnbound(),/容量/);
  assert.equal(p.storage.getItem(key),full);
  assert.equal(raw.getItem(key),prior);
});
