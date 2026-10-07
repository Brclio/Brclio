'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getCopyPathsFromURL, getCopyPathsFromURLs, MAX_PAYLOAD_BYTES } = require('./deep-link.cjs');

const encode = paths => Buffer.from(JSON.stringify(paths), 'utf8').toString('base64url');
const link = paths => `brclio://copy-path?payload=${encode(paths)}`;
const invalid = value => assert.throws(() => getCopyPathsFromURL(value), /Finder 路径请求无效/);

test('Finder URL preserves absolute paths and literal Unicode, spaces, quotes, shell syntax', () => {
  const paths = ['/Users/中文 用户/a b.txt', '/Volumes/Disk/O\'Reilly "file";$(touch x)&.txt', '/Applications/Brclio.app', '/'];
  assert.deepEqual(getCopyPathsFromURL(link(paths)), paths);
  assert.deepEqual(getCopyPathsFromURL(link(paths).replace('brclio:', 'BRCLIO:')), paths);
  assert.deepEqual(getCopyPathsFromURL(link(paths).replace('copy-path?', 'copy-path/?')), paths);
});

test('unrelated arguments and URL schemes do not become Finder copy commands', () => {
  for (const value of [undefined, null, 1, {}, '', '--copy-path', '/tmp/file', 'https://example.com/file']) assert.equal(getCopyPathsFromURL(value), null);
  const paths = ['/tmp/file'];
  assert.deepEqual(getCopyPathsFromURLs(['electron', '/app', '--flag', link(paths)]), paths);
  assert.equal(getCopyPathsFromURLs(['electron', '/app', 'https://example.com']), null);
  assert.deepEqual(getCopyPathsFromURLs([link(paths), link(['/tmp/other'])]), paths);
  assert.throws(() => getCopyPathsFromURLs(['brclio://unsupported', link(paths)]), /Finder 路径请求无效/);
});

test('only the exact copy action and one payload parameter are accepted', () => {
  const payload = encode(['/tmp/file']);
  for (const value of [
    `brclio://other?payload=${payload}`, `brclio://copy-path/action?payload=${payload}`,
    `brclio://copy-path//?payload=${payload}`, `brclio://user@copy-path?payload=${payload}`,
    `brclio://user:password@copy-path?payload=${payload}`, `brclio://copy-path:123?payload=${payload}`,
    `brclio://copy-path?payload=${payload}#fragment`, 'brclio://copy-path',
    `brclio://copy-path?payload=${payload}&payload=${payload}`, `brclio://copy-path?payload=${payload}&extra=1`,
    `brclio://copy-path?Payload=${payload}`, 'brclio://copy-path?payload=', 'brclio://',
  ]) invalid(value);
});

test('payload requires canonical unpadded base64url rather than permissive Buffer decoding', () => {
  const payload = encode(['/ab']); // Seven JSON bytes ensure unused trailing bits.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alteredBits = payload.slice(0, -1) + alphabet[alphabet.indexOf(payload.at(-1)) + 1];
  assert.deepEqual(Buffer.from(alteredBits, 'base64url'), Buffer.from(payload, 'base64url'));
  for (const encoded of [payload + '=', alteredBits, payload + '!', '+/', 'a', '_', 'not-base64%']) invalid(`brclio://copy-path?payload=${encoded}`);
});

test('payload rejects malformed UTF-8, malformed JSON, and non-array or non-string values', () => {
  const malformedUTF8 = Buffer.from([0x5b, 0x22, 0x2f, 0xc3, 0x28, 0x22, 0x5d]);
  invalid(`brclio://copy-path?payload=${malformedUTF8.toString('base64url')}`);
  invalid(`brclio://copy-path?payload=${Buffer.from('["/missing-bracket"').toString('base64url')}`);
  for (const paths of [null, {}, '/tmp/file', [], [null], [1], [{}], [['/tmp/file']]]) invalid(link(paths));
});

test('payload rejects relative paths and C0, DEL, or C1 control characters', () => {
  for (const paths of [[''], ['relative/file'], ['./file'], ['../file'], ['C:\\file'], ['\\\\server\\file']]) invalid(link(paths));
  for (const character of ['\0', '\t', '\n', '\r', '\x1f', '\x7f', '\u0080', '\u0085', '\u009f']) invalid(link([`/tmp/a${character}b`]));
});

test('payload byte and path-count boundaries are enforced without truncation', () => {
  const thousand = Array.from({ length: 1000 }, (_, index) => `/tmp/${index}`);
  assert.deepEqual(getCopyPathsFromURL(link(thousand)), thousand);
  invalid(link([...thousand, '/tmp/1000']));
  const maximum = ['/' + 'x'.repeat(MAX_PAYLOAD_BYTES - 5)];
  assert.equal(Buffer.byteLength(JSON.stringify(maximum)), MAX_PAYLOAD_BYTES);
  assert.deepEqual(getCopyPathsFromURL(link(maximum)), maximum);
  invalid(link([maximum[0] + 'x']));
  invalid(`brclio://copy-path?payload=${'a'.repeat(MAX_PAYLOAD_BYTES * 2)}`);
  invalid(link(['/' + '中'.repeat(MAX_PAYLOAD_BYTES / 2)]));
});
