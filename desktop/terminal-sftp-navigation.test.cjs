'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { history, filter, properties } = require('./terminal/sftp-navigation.js');

test('each pane tracks successful canonical paths, preserves the forward branch on refresh and drops it on a new visit', () => {
  const left = history(), right = history();
  left.visit('/start'); left.visit('/a'); left.visit('/b');
  assert.equal(left.target(-1), '/a');
  // Looking up a destination for a failed goto must leave the cursor at /b.
  assert.equal(left.target(-1), '/a');
  assert.equal(left.target(1), null);
  left.visit('/a', -1); left.visit('/a');
  assert.equal(left.target(1), '/b');
  left.visit('/b', 1); left.visit('/a', -1); left.visit('/new');
  assert.equal(left.target(1), null);
  assert.equal(left.target(-1), '/a');
  assert.equal(right.target(-1), null);
  for (let i = 0; i < 80; i++) right.visit(String(i));
  for (let i = 78; i >= 16; i--) {
    assert.equal(right.target(-1), String(i));
    right.visit(String(i), -1);
  }
  assert.equal(right.target(-1), null);
});

test('literal Unicode file name filtering applies to visible files and directories', () => {
  const entries = ['Résumé.TXT', '.résumé.txt', 'A[1]', '目录'].map(name => ({ name }));
  assert.deepEqual(filter(entries, 'RE\u0301SU', false), [entries[0]]);
  assert.deepEqual(filter(entries, 'umé', true), entries.slice(0, 2));
  assert.deepEqual(filter(entries, '[1]', false), [entries[2]]);
  assert.deepEqual(filter(entries, '目', false), [entries[3]]);
  assert.deepEqual(filter(entries, 'unknown', true), []);
});

test('only valid SFTP attributes appear, including epoch and zero permissions', () => {
  assert.deepEqual(properties({}), { modified:'', mode:'' });
  assert.deepEqual(properties({ mtime:-1, mode:-1 }), properties(null));
  const attr = properties({ mtime:0, mode:0o104755 });
  assert.ok(attr.modified);
  assert.equal(attr.mode, '4755');
  assert.equal(properties({ mode:0o100000 }).mode, '0000');
});
