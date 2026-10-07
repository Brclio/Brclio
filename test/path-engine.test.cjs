'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { DEFAULT_SETTINGS, normalizeSettings, formatPath, formatPaths } = require('../core/path-engine.cjs');

function errorWith(code, pattern) {
  return error => error.code === `BRCLIO_PATH_${code}` && pattern.test(error.message);
}

test('defaults are absolute native paths without wrappers, and stay immutable', () => {
  assert.deepEqual(normalizeSettings(), DEFAULT_SETTINGS);
  assert.equal(formatPath('/Users/悦创/项目/笔记.md'), '/Users/悦创/项目/笔记.md');
  assert.equal(formatPath('C:/Users/Brclio/Notes.md'), 'C:\\Users\\Brclio\\Notes.md');
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS), true);
});

test('settings accept only known values and true booleans', () => {
  assert.deepEqual(normalizeSettings({ pathMode: 'bad', quoteMode: 'shell', separator: 'auto', joinWith: ';', trailingSlash: 'true', launchAtLogin: 1, basePath: null, unused: true }), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ pathMode: 'relative', basePath: '/a', quoteMode: 'single', separator: 'forward', trailingSlash: true, joinWith: 'space', launchAtLogin: true }), {
    pathMode: 'relative', basePath: '/a', quoteMode: 'single', separator: 'forward', trailingSlash: true, joinWith: 'space', launchAtLogin: true
  });
});

test('absolute normalization removes dot segments and clamps traversal at the root', () => {
  const cases = [
    ['/a//b/./c/../d/', '/a/b/d'],
    ['/../../a/../b', '/b'],
    ['///a////b', '/a/b'],
    ['C:\\a/./b\\..\\c\\', 'C:\\a\\c'],
    ['C://a///b', 'C:\\a\\b'],
    ['c:/../../a', 'c:\\a'],
    ['\\\\server\\share\\folder\\..\\..\\..\\file', '\\\\server\\share\\file']
  ];
  for (const [input, expected] of cases) assert.equal(formatPath(input), expected, input);
});

test('root paths remain roots even with trailing slashes disabled', () => {
  assert.equal(formatPath('/'), '/');
  assert.equal(formatPath('C:/'), 'C:\\');
  assert.equal(formatPath('\\\\server\\share'), '\\\\server\\share\\');
  assert.equal(formatPath('//server/share', { separator: 'forward' }), '//server/share/');
});

test('relative paths require an explicit absolute base and never silently fall back', () => {
  assert.throws(() => formatPath('/a/b', { pathMode: 'relative' }), errorWith('BASE_REQUIRED', /参考目录/));
  assert.throws(() => formatPath('/a/b', { pathMode: 'relative', basePath: 'a' }), errorWith('NOT_ABSOLUTE', /参考目录必须是绝对路径/));
  for (const input of ['notes.txt', './notes.txt', '../notes.txt', 'C:notes.txt', '\\notes.txt']) {
    assert.throws(() => formatPath(input), errorWith('NOT_ABSOLUTE', /绝对路径/), input);
  }
});

test('POSIX relative paths use segment ancestry and preserve target spelling', () => {
  const options = { pathMode: 'relative', basePath: '/Users/悦创/项目' };
  assert.equal(formatPath('/Users/悦创/项目/src/index.js', options), 'src/index.js');
  assert.equal(formatPath('/Users/悦创/图片/封面.png', options), '../图片/封面.png');
  assert.equal(formatPath('/Users/悦创/项目', options), '.');
  assert.equal(formatPath('/Users/悦创/项目-old/a', options), '../项目-old/a');
  assert.equal(formatPath('/a/A/file', { pathMode: 'relative', basePath: '/a/a' }), '../A/file');
  assert.equal(formatPath('/a', { pathMode: 'relative', basePath: '/a/b/c' }), '../..');
});

test('Windows relative comparisons ignore case but retain target case', () => {
  assert.equal(formatPath('c:\\Users\\BRCLIO\\Docs\\Read Me.md', { pathMode: 'relative', basePath: 'C:/users/brclio' }), 'Docs\\Read Me.md');
  assert.equal(formatPath('D:\\Work\\素材\\封面.png', { pathMode: 'relative', basePath: 'd:\\work\\文档', separator: 'forward' }), '../素材/封面.png');
  assert.equal(formatPath('C:\\WORK', { pathMode: 'relative', basePath: 'c:\\work' }), '.');
});

test('relative UNC paths stay within their server and share', () => {
  assert.equal(formatPath('\\\\SERVER\\Share\\Assets\\a.png', { pathMode: 'relative', basePath: '//server/share/docs' }), '..\\Assets\\a.png');
  for (const [path, basePath] of [
    ['D:\\a', 'C:\\a'],
    ['\\\\server\\share-a\\a', '\\\\server\\share-b\\a'],
    ['\\\\server-a\\share\\a', '\\\\server-b\\share\\a'],
    ['C:\\a', '/a'],
    ['/a', '\\\\server\\share\\a']
  ]) assert.throws(() => formatPath(path, { pathMode: 'relative', basePath }), errorWith('CROSS_ROOT', /磁盘、网络共享或文件系统/));
});

test('incomplete or ambiguous Windows UNC roots are rejected', () => {
  for (const input of ['\\\\server', '\\\\server\\', '\\\\server\\..\\a', '\\\\.\\share\\a']) {
    assert.throws(() => formatPath(input), errorWith('INVALID_UNC', /服务器名和共享名/), input);
  }
});

test('native and explicit separators do not rewrite POSIX backslashes inside names', () => {
  assert.equal(formatPath('/tmp/a\\b/file.txt'), '/tmp/a\\b/file.txt');
  assert.equal(formatPath('/tmp/a\\b/file.txt', { separator: 'forward' }), '/tmp/a\\b/file.txt');
  assert.equal(formatPath('/tmp/a\\b/file.txt', { separator: 'backward' }), '\\tmp\\a\\b\\file.txt');
  assert.equal(formatPath('C:/a/b', { separator: 'forward' }), 'C:/a/b');
  assert.equal(formatPath('/tmp/a\\b/file.txt', { pathMode: 'relative', basePath: '/tmp/a\\b' }), 'file.txt');
});

test('a folder suffix is added only when directory metadata is present', () => {
  const options = { trailingSlash: true };
  assert.equal(formatPath({ path: '/a/b', kind: 'directory' }, options), '/a/b/');
  assert.equal(formatPath({ path: '/a/b', kind: 'file' }, options), '/a/b');
  assert.equal(formatPath('/a/b', options), '/a/b');
  assert.equal(formatPath({ path: 'C:/a/b', kind: 'directory' }, options), 'C:\\a\\b\\');
  assert.equal(formatPath({ path: '/a', kind: 'directory' }, { pathMode: 'relative', basePath: '/a', trailingSlash: true }), './');
  assert.equal(formatPath({ path: '/a/', kind: 'directory' }), '/a');
});

test('quote modes wrap literal path text without claiming or performing shell escaping', () => {
  assert.equal(formatPath('/a/Read Me.txt', { quoteMode: 'double' }), '"/a/Read Me.txt"');
  assert.equal(formatPath("/a/it's.txt", { quoteMode: 'single' }), "'/a/it's.txt'");
  assert.equal(formatPath('/a/a"b.txt', { quoteMode: 'double' }), '"/a/a"b.txt"');
  assert.equal(formatPath('/a/plain.txt', { quoteMode: 'auto' }), '/a/plain.txt');
  assert.equal(formatPath('/a/Read Me.txt', { quoteMode: 'auto' }), '"/a/Read Me.txt"');
  assert.equal(formatPath('/a/$(touch injected)', { quoteMode: 'auto' }), '"/a/$(touch injected)"');
  assert.equal(formatPath("/a/it's.txt", { quoteMode: 'auto' }), '"/a/it\'s.txt"');
  assert.equal(formatPath('/a/ space ', { quoteMode: 'none' }), '/a/ space ');
});

test('Android content URIs are preserved exactly without filesystem conversions', () => {
  const uri = 'content://com.android.providers.downloads.documents/document/msf%3A124?displayName=a%20b';
  assert.equal(formatPath(uri), uri);
  assert.equal(formatPath({ path: uri, isUri: true, kind: 'directory' }, { separator: 'backward', trailingSlash: true }), uri);
  assert.equal(formatPath(uri, { quoteMode: 'double' }), `"${uri}"`);
  assert.throws(() => formatPath(uri, { pathMode: 'relative', basePath: '/storage/emulated/0' }), errorWith('URI_RELATIVE', /内容 URI/));
  assert.throws(() => formatPath('/a', { pathMode: 'relative', basePath: uri }), errorWith('URI_BASE', /不能作为参考目录/));
  assert.throws(() => formatPath({ path: '/a', isUri: true }), errorWith('INVALID_URI', /URI 无效/));
});

test('other explicit provider URIs retain encoding and are not treated as drives', () => {
  assert.equal(formatPath('file:///storage/emulated/0/a%20b.txt'), 'file:///storage/emulated/0/a%20b.txt');
  assert.equal(formatPath('document-provider://files/notes'), 'document-provider://files/notes');
});

test('control characters are rejected both in selected paths and the relative base', () => {
  for (const control of ['\n', '\r', '\t', '\0', '\x7f', '\x85']) {
    assert.throws(() => formatPath('/a' + control + 'b'), errorWith('CONTROL_CHARACTER', /控制字符/));
    assert.throws(() => formatPath('/a', { pathMode: 'relative', basePath: '/b' + control + 'c' }), errorWith('CONTROL_CHARACTER', /参考目录/));
  }
});

test('invalid inputs produce clear errors, while an empty selection formats to empty text', () => {
  assert.equal(formatPaths([]), '');
  for (const input of [null, undefined, 12, false]) assert.throws(() => formatPath(input), errorWith('INVALID_INPUT', /有效/));
  for (const input of ['', {}, { path: null }]) assert.throws(() => formatPath(input), errorWith('EMPTY', /不能为空/));
  assert.throws(() => formatPaths('/a'), errorWith('INVALID_INPUT', /数组/));
});

test('multiple path joins quote each item separately and report the failing item', () => {
  const paths = ['/a/one file', { path: '/a/two', name: 'two', kind: 'file' }];
  assert.equal(formatPaths(paths), '/a/one file\n/a/two');
  assert.equal(formatPaths(paths, { quoteMode: 'double', joinWith: 'space' }), '"/a/one file" "/a/two"');
  assert.equal(formatPaths(paths, { joinWith: 'comma' }), '/a/one file, /a/two');
  assert.throws(() => formatPaths(['/a', '/b\nc']), error => error.pathIndex === 1 && error.code === 'BRCLIO_PATH_CONTROL_CHARACTER' && /第 2 个路径/.test(error.message));
});

test('Win32 extended namespace drive and UNC paths keep their namespace', () => {
  assert.equal(formatPath('\\\\?\\C:\\long\\a\\..\\file.txt'), '\\\\?\\C:\\long\\file.txt');
  assert.equal(formatPath('\\\\?\\UNC\\server\\share\\a'), '\\\\?\\UNC\\server\\share\\a');
  assert.equal(formatPath('\\\\?\\C:\\Long\\file', { pathMode: 'relative', basePath: 'c:\\long' }), 'file');
  assert.equal(formatPath('\\\\?\\UNC\\SERVER\\SHARE\\a', { pathMode: 'relative', basePath: '\\\\server\\share' }), 'a');
});

test('the same source loads in a browser without Node globals or dependencies', () => {
  const sandbox = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve('../core/path-engine.cjs'), 'utf8'), sandbox);
  assert.equal(sandbox.window.BrclioPath.formatPath('/a/./b'), '/a/b');
  assert.equal(sandbox.window.BrclioPath.formatPath('C:/a', { separator: 'forward' }), 'C:/a');
  assert.equal(sandbox.window.BrclioPath.DEFAULT_SETTINGS.pathMode, 'absolute');
});
