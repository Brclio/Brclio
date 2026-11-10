'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const original = 'https://xhslink.com/safe?xsec_token=private-query';
const foreign = 'https://other.example/private-path?xsec_token=private-query#private-fragment';
const safe = 'https://www.xiaohongshu.com/explore/example';
const cases = [
  { input: foreign, code: 'XHS_URL_HOST', host: 'other.example', hop: 0 },
  { input: 'https://private-name:private-password@xhslink.com/path', code: 'XHS_URL_CREDENTIALS', host: 'xhslink.com', hop: 0 },
  { input: 'https://xhslink.cn:8443/private-path', code: 'XHS_URL_PORT', host: 'xhslink.cn', port: 8443, hop: 0 },
  { input: 'ftp://www.xiaohongshu.com/private-path', code: 'XHS_URL_PROTOCOL', host: 'www.xiaohongshu.com', hop: 0 },
  { locations: ['/allowed', foreign], code: 'XHS_URL_HOST', host: 'other.example', hop: 2 },
  { locations: ['http://xhslink.com/private-path'], code: 'XHS_URL_PROTOCOL', host: 'xhslink.com', hop: 1 },
  { locations: ['custom-app://example.com/private-path'], code: 'XHS_URL_PROTOCOL', host: 'example.com', hop: 1 },
  { locations: ['https://private-name:private-password@xhslink.com/secret'], code: 'XHS_URL_CREDENTIALS', host: 'xhslink.com', hop: 1 },
  { locations: ['https://xhslink.com:8123/private-path'], code: 'XHS_URL_PORT', host: 'xhslink.com', port: 8123, hop: 1 },
  { locations: ['https://['], code: 'XHS_URL_INVALID', hop: 1 },
  { locations: [null], code: 'XHS_REDIRECT_LOCATION', hop: 1 },
  { locations: Array.from({ length: 6 }, (_, i) => safe + i), code: 'XHS_REDIRECT_LIMIT', host: 'www.xiaohongshu.com', hop: 6 }
];

test('Node and Python emit the same redacted reason and stop before requesting a blocked URL', async () => {
  const { extractInputUrl, fetchNotePage } = await import('../desktop/xhs/lib/xhs.js');
  const nodeResults = [];
  for (const fixture of cases) {
    let requests = 0;
    await assert.rejects(async () => {
      const input = extractInputUrl(fixture.input || original);
      await fetchNotePage(input, { fetchImpl: async () => {
        const location = fixture.locations?.[requests++];
        assert.notEqual(location, undefined, 'blocked destination was requested');
        return new Response(null, { status: 302, headers: location ? { location } : {} });
      } });
    }, error => {
      const { message, diagnostic } = error;
      assert.equal(error.code, fixture.code);
      assert.equal(diagnostic.code, fixture.code);
      assert.equal(diagnostic.stage, fixture.hop ? 'redirect' : 'input');
      assert.equal(diagnostic.host, fixture.host);
      assert.equal(diagnostic.port, fixture.port);
      assert.equal(diagnostic.hop, fixture.hop);
      assert.equal(requests, fixture.hop);
      assert.match(message, /复制链接/);
      assert.doesNotMatch(message + JSON.stringify(diagnostic), /private-|xsec_token/);
      nodeResults.push({ message, diagnostic, requests });
      return true;
    });
  }

  // Exercise urllib's real redirect handling with a fixture transport, including
  // protocols that urllib normally rejects before calling redirect_request.
  const python = process.env.BRCLIO_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(python, ['-B', '-c', `
import io, json, sys
from email.message import Message
from unittest.mock import patch
from urllib.request import HTTPSHandler, build_opener
from urllib.response import addinfourl
sys.path.insert(0, sys.argv[1])
from api import python_parse as parser

class FixtureTransport(HTTPSHandler):
    def __init__(self, locations):
        super().__init__()
        self.locations = iter(locations)
        self.requests = 0
    def https_open(self, req):
        self.requests += 1
        location = next(self.locations)
        headers = Message()
        if location:
            headers["Location"] = location
        response = addinfourl(io.BytesIO(b""), headers, req.full_url, 302)
        response.msg = "Found"
        return response

results = []
for fixture in json.load(sys.stdin):
    transport = FixtureTransport(fixture.get("locations", []))
    with patch.object(parser, "build_opener", lambda redirects: build_opener(transport, redirects)):
        try:
            parser.fetch_note_page(parser.extract_input_url(fixture.get("input", sys.argv[2])))
        except parser.XhsError as error:
            results.append({"message": str(error), "diagnostic": error.diagnostic, "requests": transport.requests})
        else:
            raise AssertionError("expected refusal")
print(json.dumps(results))
`, path.resolve(__dirname, '../desktop/xhs'), original],
  { input: JSON.stringify(cases), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), nodeResults);
});
