'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');

// Chromium and Node can spell the same local file URL differently (drive-letter
// case and percent encoding). Compare decoded native paths; frame identity is
// checked independently by the caller. Queries and non-file origins are denied.
function isLocalDocument(value, expected, platform = process.platform) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || url.search) return false;
    const windows = platform === 'win32';
    const api = windows ? path.win32 : path.posix;
    const actual = api.normalize(fileURLToPath(url, { windows }));
    const wanted = api.normalize(expected);
    return windows ? actual.toLowerCase() === wanted.toLowerCase() : actual === wanted;
  } catch { return false; }
}

module.exports = { isLocalDocument };
