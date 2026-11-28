'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {merge} = require('./terminal/snippet-sync-model.js');
const snippet = (id,text) => ({id,kind:'snippet',name:id,text});

test('snippet sync preserves independent edits and resolves concurrent update or delete explicitly', () => {
  const a = snippet('a','before'), edit = snippet('a','after'), b = snippet('b','separate');
  assert.deepEqual(merge([a],[edit],[a,b]),{items:[edit,b],conflicts:[]});
  assert.deepEqual(merge([a],[],[edit]).conflicts,['a']);
  assert.deepEqual(merge([a],[],[edit],'local').items,[]);
  assert.deepEqual(merge([a],[],[edit],'cloud').items,[edit]);
  assert.throws(() => merge([],[],[a,a]));
  assert.throws(() => merge([],[],[{...b,kind:'note'}]));
});
