'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { mockElectronRequest } = require('./electron-update-request-fixture.cjs');

const noteId = 'abcdef1234567890abcdef12';
const shortURL = 'https://xhslink.cn/o/source-client';
const noteURL = `https://www.xiaohongshu.com/explore/${noteId}`;
const imageURL = 'https://ci.xiaohongshu.com/source-image';
const finalImageURL = 'https://sns-webpic-qc.xhscdn.com/source-image';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

test('source transport split: Node parses short links and proxies media; native saves use the original redirect adapter', async t => {
  const { createXhsService } = await import('../desktop/xhs/index.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-xhs-network-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'downloads'); await fs.mkdir(output);
  const nodeCalls = [], nativeCalls = [], proxyModes = [];
  let sessionFetchCalls = 0;
  const browserSession = {
    setProxy: async options => proxyModes.push(options.mode),
    fetch() { sessionFetchCalls++; throw new Error('Redirect was cancelled'); },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = String(input); nodeCalls.push(url);
    assert.equal(options.redirect, 'manual');
    if (url === shortURL) return new Response(null, { status: 302, headers: { location: noteURL } });
    if (url === noteURL) return new Response(`<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: {
      [noteId]: { note: { noteId, title: '原版短链解析', imageList: [{ urlDefault: imageURL }] } },
    } } })}</script>`);
    if (url === imageURL) return new Response(png, { headers: { 'content-type': 'image/png' } });
    throw new Error('Unexpected Node destination');
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const service = await createXhsService({
    app: { getPath: name => name === 'downloads' ? output : directory, getAppPath: () => path.resolve(__dirname, '..'), isPackaged: true },
    session: { fromPartition: name => { assert.equal(name, 'persist:brclio-xhs'); return browserSession; } },
    net: { request: mockElectronRequest(async (url, options) => {
      nativeCalls.push(url);
      assert.equal(options.session, browserSession);
      assert.equal(options.redirect, 'manual');
      assert.equal(options.useSessionCookies, false);
      assert.equal(options.credentials, 'omit');
      if (url === imageURL) return new Response(null, { status: 302, headers: { location: finalImageURL } });
      assert.equal(url, finalImageURL);
      return new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
    }) },
    BrowserWindow: class { constructor() { throw new Error('Single-note requests cannot open a login window'); } },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [output] }) },
  });
  t.after(() => service.close());
  const parsed = await service.request('parse', { text: `分享文案 ${shortURL} 阅读全文`, engine: 'node' });
  assert.equal(parsed.title, '原版短链解析');
  assert.equal(parsed.sourceUrl, noteURL);
  assert.deepEqual(nodeCalls, [shortURL, noteURL]);
  const preview = await service.handleProtocol(new Request(`brclio-xhs://local/api/image?url=${encodeURIComponent(imageURL)}`));
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
  const result = await service.request('saveImages', { title: parsed.title, images: [{ index: 1, url: imageURL }] });
  assert.deepEqual(await fs.readFile(path.join(result.path, result.files[0].name)), png);
  assert.deepEqual(nativeCalls, [imageURL, finalImageURL]);
  assert.deepEqual(nodeCalls, [shortURL, noteURL, imageURL]);
  assert.deepEqual(proxyModes, ['direct']);
  assert.equal(sessionFetchCalls, 0);
});
