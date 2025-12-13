import http from 'node:http';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { compressModule, MIN_BODY_SIZE } from '../dist/_esm/index.node.js';
import { compress_call } from '../dist/_esm/jit-compressor.js';
import { BASE_RPC_URL, loadFixture } from './utils';

const largeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'eth_blockNumber',
  params: [],
  _padding: 'x'.repeat(MIN_BODY_SIZE),
});

const smallBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'eth_blockNumber',
  params: [],
});

describe('Mock Server Tests', () => {
  let mockServer: http.Server;
  let mockUrl: string;
  let lastRequest: { method: string; headers: http.IncomingHttpHeaders; body: Buffer } | null =
    null;

  beforeAll(async () => {
    mockServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      lastRequest = { method: req.method || 'GET', headers: req.headers, body };

      const enc = req.headers['content-encoding'];
      const path = req.url || '';
      if (path.includes('reject-gzip') && enc === 'gzip') {
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

  afterAll(() => mockServer?.close());

  const post = (mode?: any) =>
    compressModule(
      mockUrl + '/' + Date.now() + Math.random(),
      { method: 'POST', body: largeBody, headers: { 'Content-Type': 'application/json' } },
      mode,
    );

  test('passive: 1st uncompressed, 2nd compressed', async () => {
    const url = mockUrl + '/passive-' + Date.now();
    const opts = {
      method: 'POST',
      body: largeBody,
      headers: { 'Content-Type': 'application/json' },
    };

    await compressModule(url, opts);
    expect(lastRequest!.headers['content-encoding']).toBeUndefined();

    lastRequest = null;
    await compressModule(url, opts);
    expect(lastRequest!.headers['content-encoding']).toBe('gzip');
  });

  test('proactive: 1st compressed', async () => {
    await post('proactive');
    expect(lastRequest!.headers['content-encoding']).toBe('gzip');
  });

  test('proactive: reject gzip, fall back to deflate on 2nd request', async () => {
    const url = mockUrl + '/reject-gzip-' + Date.now();
    const opts = {
      method: 'POST',
      body: largeBody,
      headers: { 'Content-Type': 'application/json' },
    };

    const res1 = await compressModule(url, opts, 'proactive');
    expect(lastRequest!.headers['content-encoding']).toBe('gzip');
    expect(res1.ok).toBe(false);

    lastRequest = null;
    const res2 = await compressModule(url, opts, 'proactive');
    expect(lastRequest!.headers['content-encoding']).toBe('deflate');
    expect(res2.ok).toBe(true);
  });

  test('gzip: always gzip', async () => {
    await post('gzip');
    expect(lastRequest!.headers['content-encoding']).toBe('gzip');
  });

  test('deflate: always deflate', async () => {
    await post('deflate');
    expect(lastRequest!.headers['content-encoding']).toBe('deflate');
  });

  test('transform: no Content-Encoding', async () => {
    await post((p: any) => ({ ...p, x: 1 }));
    expect(lastRequest!.headers['content-encoding']).toBeUndefined();
  });

  test('Request input: preserves HTTP method when init omits it', async () => {
    const url = mockUrl + '/request-' + Date.now();
    const req = new Request(url, { method: 'POST' });
    await compressModule(
      req,
      { body: largeBody, headers: { 'Content-Type': 'application/json' } },
      'gzip',
    );
    expect(lastRequest!.method).toBe('POST');
    expect(lastRequest!.headers['content-encoding']).toBe('gzip');
  });

  test('small body: not compressed', async () => {
    await compressModule(mockUrl + '/' + Date.now(), {
      method: 'POST',
      body: smallBody,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(lastRequest!.headers['content-encoding']).toBeUndefined();
  });

  test('transform returning undefined: body unchanged', async () => {
    const res = await post(() => undefined);
    expect(res.ok).toBe(true);
  });

  test('non-JSON body: transform skipped', async () => {
    let called = false;
    await compressModule(
      mockUrl + '/' + Date.now(),
      { method: 'POST', body: 'not-json', headers: { 'Content-Type': 'text/plain' } },
      () => {
        called = true;
        return {};
      },
    );
    expect(called).toBe(false);
  });
});

describe('JIT transform', () => {
  test('compress_call as transform', async () => {
    const testData = loadFixture('36670119.raw.json');
    const tx = testData.transactions.find((t: any) => t.input?.length > 2000);
    if (!tx) return;

    const res = await compressModule(
      BASE_RPC_URL,
      {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to: tx.to, data: tx.input }, 'latest'],
        }),
        headers: { 'Content-Type': 'application/json' },
      },
      compress_call,
    );

    expect(res.ok).toBe(true);
    const json = await res.json();
    expect(json.result).toBeDefined();
  });
});
