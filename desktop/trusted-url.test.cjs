'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isLocalDocument } = require('./trusted-url.cjs');

test('local document trusts equivalent native paths and hash navigation across platforms', () => {
  assert.ok(isLocalDocument('file:///Applications/Brclio.app/web/index.html#settings', '/Applications/Brclio.app/web/index.html', 'darwin'));
  assert.ok(isLocalDocument('file:///d:/Brclio%20%E4%B8%AD%E6%96%87%20%26%20test/web/index.html', 'D:\\Brclio 中文 & test\\web\\index.html', 'win32'));
  assert.ok(isLocalDocument('file:///C:/Brclio%27s/web/index.html', "C:\\Brclio's\\web\\index.html", 'win32'));
  assert.ok(isLocalDocument('file:///C:/Brclio%20&%20test/web/index.html', 'C:\\Brclio & test\\web\\index.html', 'win32'));
});

test('local document rejects remote origins, different files, queries, malformed and encoded separators', () => {
  const expected = '/Applications/Brclio.app/web/index.html';
  for (const url of ['https://example.com/index.html', 'file://example.com/Applications/Brclio.app/web/index.html', 'file:///Applications/Other.app/web/index.html', 'file:///Applications/Brclio.app/web/index.html?remote=1', 'file:///Applications/Brclio.app%2fweb/index.html', 'file:///%ZZ', 'about:blank']) {
    assert.equal(isLocalDocument(url, expected, 'darwin'), false, url);
  }
  assert.equal(isLocalDocument('file:///Applications/brclio.app/web/index.html', expected, 'darwin'), false);
});
