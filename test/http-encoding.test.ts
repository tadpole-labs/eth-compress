import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import zlib from 'node:zlib';
import * as u from './support/index.ts';

const largeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'eth_blockNumber',
  params: [],
  _padding: 'x'.repeat(u.MIN_BODY_SIZE),
});
const smallBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });

const jsonOpts = (body = largeBody) => ({
  method: 'POST' as const,
  body,
  headers: { 'Content-Type': 'application/json' },
});

describe('compressModule Content-Encoding negotiation', () => {
  let mockServer: http.Server;
  let mockUrl: string;
  let lastRequest: { method: string; headers: http.IncomingHttpHeaders; body: Buffer } | null =
    null;

  before(async () => {
    mockServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      lastRequest = { method: req.method || 'GET', headers: req.headers, body };

      const enc = req.headers['content-encoding'];
      if ((req.url || '').includes('reject-gzip') && enc === 'gzip') {
        res.writeHead(415, { 'Content-Type': 'application/json', 'Accept-Encoding': 'deflate' });
        res.end(JSON.stringify({ error: 'gzip rejected' }));
        return;
      }
      let data = body;
      try {
        if (enc === 'gzip') data = zlib.gunzipSync(body);
        else if (enc === 'deflate') data = zlib.inflateSync(body);
        const json = JSON.parse(data.toString());
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: json.id, result: '0x123' }));
      } catch {
        res.writeHead(400, {
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        });
        res.end(JSON.stringify({ error: 'bad request' }));
      }
    });

    await new Promise<void>((r) => {
      mockServer.listen(0, () => {
        const addr = mockServer.address();
        mockUrl = `http://localhost:${typeof addr === 'object' ? addr!.port : 0}`;
        r();
      });
    });
  });

  after(() => mockServer?.close());

  const post = (mode?: any) =>
    u.compressModule(mockUrl + '/' + Date.now() + Math.random(), jsonOpts(), mode);
  const enc = () => lastRequest!.headers['content-encoding'];

  test('passive: 1st uncompressed, 2nd compressed', async () => {
    const url = mockUrl + '/passive-' + Date.now();
    await u.compressModule(url, jsonOpts());
    assert.equal(enc(), undefined);
    lastRequest = null;
    await u.compressModule(url, jsonOpts());
    assert.equal(enc(), 'gzip');
  });

  test('proactive: 1st compressed', async () => {
    await post('proactive');
    assert.equal(enc(), 'gzip');
  });

  test('proactive: reject gzip, fall back to deflate on 2nd request', async () => {
    const url = mockUrl + '/reject-gzip-' + Date.now();
    const res1 = await u.compressModule(url, jsonOpts(), 'proactive');
    assert.equal(enc(), 'gzip');
    assert.equal(res1.ok, false);
    lastRequest = null;
    const res2 = await u.compressModule(url, jsonOpts(), 'proactive');
    assert.equal(enc(), 'deflate');
    assert.equal(res2.ok, true);
  });

  test('gzip: always gzip', async () => {
    await post('gzip');
    assert.equal(enc(), 'gzip');
  });

  test('deflate: always deflate', async () => {
    await post('deflate');
    assert.equal(enc(), 'deflate');
  });

  test('transform: no Content-Encoding', async () => {
    await post((p: any) => ({ ...p, x: 1 }));
    assert.equal(enc(), undefined);
  });

  test('Request input: preserves HTTP method when init omits it', async () => {
    const req = new Request(mockUrl + '/request-' + Date.now(), { method: 'POST' });
    await u.compressModule(
      req,
      { body: largeBody, headers: { 'Content-Type': 'application/json' } },
      'gzip',
    );
    assert.equal(lastRequest!.method, 'POST');
    assert.equal(enc(), 'gzip');
  });

  test('small body: not compressed', async () => {
    await u.compressModule(mockUrl + '/' + Date.now(), jsonOpts(smallBody));
    assert.equal(enc(), undefined);
  });

  test('transform returning undefined: body unchanged', async () => {
    assert.equal((await post(() => undefined)).ok, true);
  });

  test('non-JSON body: transform skipped', async () => {
    let called = false;
    await u.compressModule(
      mockUrl + '/' + Date.now(),
      { method: 'POST', body: 'not-json', headers: { 'Content-Type': 'text/plain' } },
      () => {
        called = true;
        return {};
      },
    );
    assert.equal(called, false);
  });
});
