'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { capture, restore, store } = require('./terminal/arrangements.js');

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), values };
}

function leaf(profile, cwd = null, shellIntegration = false) { return { profile, cwd, shellIntegration }; }
function split(direction, fraction, first, second) { return { direction, fraction, first, second }; }

test('reopening an arrangement requires a separate user action to start a remote connection', () => {
  const layouts = store(storage());
  const root = { ...leaf('ssh'), connection: { host: 'build-host', user: 'me' } };
  layouts.save('remote', { tabs: [{ name: '工作', root }], activeTab: 0 });
  assert.deepEqual(layouts.get('remote').tabs[0].root, leaf('default'));
});
const three = { tabs: [
  { name: '编译', activePane: 1, root: split('right', .35, leaf('zsh'), split('down', .7, leaf('bash', '/tmp/with spaces', true), leaf('default'))) },
  { name: '', activePane: 0, root: leaf('default') },
], activeTab: 0 };

test('named arrangements persist only launch settings, explicit names and layout', () => {
  const memory = storage();
  const bank = store(memory);
  const raw = structuredClone(three);
  const privateValue = 'private command, prompt and output';
  raw.tabs[0].root.first.output = raw.tabs[0].root.first.history = privateValue;
  raw.tabs[1].title = privateValue;
  bank.save(' 日常 ', raw);
  assert.deepEqual(store(memory).get('日常'), three);
  assert.deepEqual(bank.names(), ['日常']);
  assert.ok(![...memory.values.values()][0].includes(privateValue));
  assert.throws(() => bank.save('日常', three), /已被使用/);
  assert.throws(() => bank.save('bad\nname', three), /名称/);
  bank.remove('日常');
  assert.deepEqual(bank.names(), []);
});

test('capture reads ordered tabs, nested split fractions and the selected pane', () => {
  function fakePane(options) {
    const el = { classList: { contains: name => name === 'pane' }, style: {} };
    el.pane = { launch: options, title: 'untrusted dynamic title' };
    return el;
  }
  function fakeSplit(direction, fraction, first, second) {
    first.style.flexGrow = String(fraction);
    return { classList: { contains: () => false }, dataset: { direction }, style: {}, firstElementChild: first, lastElementChild: second };
  }
  const one = fakePane(leaf('zsh')), two = fakePane(leaf('bash', '/tmp/with spaces', true)), threePane = fakePane(leaf('default'));
  const secondTab = fakePane(leaf('default'));
  const tabs = [{ customName: '编译', panel: { firstElementChild: fakeSplit('right', .35, one, fakeSplit('down', .7, two, threePane)) }, active: two.pane },
    { customName: '', panel: { firstElementChild: secondTab }, active: secondTab.pane }];
  assert.deepEqual(capture(tabs, tabs[0], element => element.pane), three);
});

test('restoring appends a new session for every leaf while retaining active panes and split geometry', () => {
  const existing = { pid: 1234 };
  const tabs = [existing], calls = [];
  let selected;
  const controls = {
    liveCount: () => 1,
    newTab(name, launch) {
      const tab = { name };
      tabs.push(tab);
      return { tab, launch };
    },
    split(direction, pane, opts, fraction) {
      calls.push({ direction, fraction, first: pane.launch.profile, second: opts.profile });
      return { tab: pane.tab, launch: opts };
    },
    selectPane(pane) { pane.tab.active = pane.launch; },
    selectTab(tab) { selected = tab; },
  };
  assert.equal(restore(three, controls), 2);
  assert.equal(tabs[0], existing);
  assert.equal(selected, tabs[1]);
  assert.deepEqual(tabs[1].active, leaf('bash', '/tmp/with spaces', true));
  assert.deepEqual(calls, [
    { direction: 'right', fraction: .35, first: 'zsh', second: 'bash' },
    { direction: 'down', fraction: .7, first: 'bash', second: 'default' },
  ]);
  controls.liveCount = () => 29;
  assert.throws(() => restore(three, controls), /超过/);
  assert.equal(tabs.length, 3);
  const invalid = structuredClone(three);
  invalid.tabs[1].root.profile = { invalid: true };
  assert.throws(() => restore(invalid, controls), /Shell/);
  assert.equal(tabs.length, 3);
});

test('remembering an explicitly saved destination stores only a protocol, name and route fingerprint',async () => {
  const {reference} = require('./terminal/arrangements.js');
  const target = {host:'node.example',port:2022,user:'operator',identityFile:'/local/private-file',
    password:'private value',environment:[{name:'SECRET',value:'environment value'}]};
  const savedHost = await reference('生产节点','ssh',target);
  assert.deepEqual(Object.keys(savedHost).sort(),['fingerprint','name','protocol']);
  assert.equal((await reference('生产节点','ssh',{...target,port:2222})).fingerprint === savedHost.fingerprint,false);
  assert.equal((await reference('生产节点','ssh',{...target,password:'different'})).fingerprint,savedHost.fingerprint);
  const node = {classList:{contains:() => true}};
  const pane = {launch:{profile:'ssh',connection:target},savedHost};
  const tab = {panel:{firstElementChild:node},active:pane,customName:''};
  const memory = storage(), bank = store(memory);
  const snapshot = checked => capture([tab],tab,() => pane,checked);
  bank.save('Default',snapshot(false)); bank.save('Remembered',snapshot(true));
  assert.deepEqual(bank.get('Default').tabs[0].root,leaf('default'));
  assert.deepEqual(bank.get('Remembered').tabs[0].root,{...leaf('default'),savedHost});
  const serialized = [...memory.values.values()].join('');
  for (const privateText of ['node.example','operator','/local/private-file','private value','environment value']) assert.ok(!serialized.includes(privateText));
  pane.savedHost = undefined;
  assert.deepEqual(snapshot(true).tabs[0].root,leaf('default'));
});
