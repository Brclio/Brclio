'use strict';

// node scripts/benchmark-xhs-archive.cjs [Brclio checkout]
// Exercises the desktop IPC service with real filesystem I/O and an in-memory CDN.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { crc32 } = require('node:zlib');

const imageBytes = 768 * 1024;
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const sha256 = data => createHash('sha256').update(data).digest('hex');

function makeImage(index) {
  // Insert a PNG comment before IEND, with distinct data for each image.
  const comment = Buffer.alloc(imageBytes - tinyPng.length, 65 + index);
  comment.writeUInt32BE(comment.length - 12);
  comment.write('tEXtComment\0', 4, 'ascii');
  comment.writeUInt32BE(crc32(comment.subarray(4, -4)), comment.length - 4);
  return Buffer.concat([tinyPng.subarray(0, -12), comment, tinyPng.subarray(-12)]);
}

function verifyZip(zip, images) {
  let offset = 0;
  const names = [];
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(zip.readUInt16LE(offset + 8), 0, 'expected a Store ZIP');
    const nameLength = zip.readUInt16LE(offset + 26);
    const start = offset + 30 + nameLength + zip.readUInt16LE(offset + 28);
    const end = start + zip.readUInt32LE(offset + 18);
    const entry = zip.subarray(start, end);
    assert.equal(crc32(entry), zip.readUInt32LE(offset + 14));
    if (names.length) assert.equal(sha256(entry), images[names.length - 1].sha256);
    names.push(zip.toString('utf8', offset + 30, offset + 30 + nameLength));
    offset = end;
  }
  assert.deepEqual(names, ['笔记.txt', ...images.map(({ index }) => `${String(index).padStart(3, '0')}-基准.png`)]);
}

async function benchmark() {
  const checkout = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  const { createXhsService } = await import(pathToFileURL(path.join(checkout, 'desktop/xhs/index.mjs')));
  const images = Array.from({ length: 24 }, (_, i) => {
    const data = makeImage(i);
    return { index: i + 1, url: `https://ci.xiaohongshu.com/zip-bench-${i}?imageView2/format/jpg`, data, sha256: sha256(data) };
  });
  const fixtures = new Map(images.map(image => [image.url, image.data]));
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-zip-bench-')));
  const target = path.join(directory, 'result.zip');
  const originalOpen = fs.open, originalReadFile = fs.readFile;
  const isStagedMedia = filename => typeof filename === 'string' && path.dirname(filename).startsWith(path.join(directory, '.brclio-xhs-zip-'));
  let counts, service;
  try {
    // Count the extra per-media pass independently of the final archive write.
    fs.open = async (filename, ...args) => {
      const file = await originalOpen(filename, ...args);
      if (isStagedMedia(filename) && filename.endsWith('.part')) {
        counts.temporaryMediaFiles++;
        const write = file.writeFile.bind(file), sync = file.sync.bind(file);
        file.writeFile = async data => { counts.mediaBytesWritten += data.byteLength; return write(data); };
        file.sync = async () => { counts.mediaSyncs++; return sync(); };
      }
      return file;
    };
    fs.readFile = async (filename, ...args) => {
      const data = await originalReadFile(filename, ...args);
      if (isStagedMedia(filename) && filename.endsWith('.png')) counts.mediaBytesRead += data.byteLength;
      return data;
    };
    service = await createXhsService({
      app: { getPath: () => directory, getAppPath: () => checkout, isPackaged: true },
      BrowserWindow: class {}, session: { fromPartition: () => ({}) },
      dialog: { showSaveDialog: async () => ({ canceled: false, filePath: target }) },
      fetchImpl: async url => {
        const data = fixtures.get(url);
        assert.ok(data, 'unexpected CDN request');
        counts.requests++;
        return new Response(data, { headers: { 'content-type': 'image/png', 'content-length': String(data.length) } });
      },
    });
    const rounds = [];
    const input = { format: 'images', note: { title: '基准' }, images: images.map(({ index, url }) => ({ index, url })) };
    for (let i = 0; i < 5; i++) {
      counts = { requests: 0, temporaryMediaFiles: 0, mediaBytesWritten: 0, mediaBytesRead: 0, mediaSyncs: 0 };
      const start = performance.now();
      const result = await service.request('exportArchive', input);
      const ms = Math.round(performance.now() - start);
      assert.equal(result.count, images.length);
      verifyZip(await fs.readFile(target), images);
      rounds.push({ ms, ...counts });
    }
    console.log(JSON.stringify({ checkout, node: process.version, imageCount: images.length, imageBytes,
      processMaxRssKiB: process.resourceUsage().maxRSS,
      medianMs: rounds.map(round => round.ms).sort((a, b) => a - b)[2], rounds }, null, 2));
  } finally {
    fs.open = originalOpen;
    fs.readFile = originalReadFile;
    try { await service?.close(); } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
}

benchmark().catch(error => { console.error(error); process.exitCode = 1; });
