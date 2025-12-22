import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { afterEach, describe, expect, test } from 'vitest';
import { compressModule } from '../dist/_esm/index.node.js';
import { compress_call } from '../dist/_esm/jit-compressor.js';
import { BASE_RPC_URL, retry2, sleep } from './utils';

describe('viem fetchFn patterns', () => {
  afterEach(async () => {
    await sleep(100);
  });

  test('passive (default)', async () => {
    const client = createPublicClient({
      chain: base,
      transport: http(BASE_RPC_URL, { fetchFn: compressModule }),
    });
    const block = await retry2(() => client.getBlockNumber());
    expect(block).toBeGreaterThan(0n);
  });

  test('passive (explicit)', async () => {
    const client = createPublicClient({
      chain: base,
      transport: http(BASE_RPC_URL, {
        fetchFn: (url, init) => compressModule(url, init, 'passive'),
      }),
    });
    const block = await retry2(() => client.getBlockNumber());
    expect(block).toBeGreaterThan(0n);
  });

  test('proactive', async () => {
    const client = createPublicClient({
      chain: base,
      transport: http(BASE_RPC_URL, {
        fetchFn: (url, init) => compressModule(url, init, 'proactive'),
      }),
    });
    const block = await retry2(() => client.getBlockNumber());
    expect(block).toBeGreaterThan(0n);
  });

  test('gzip', async () => {
    const client = createPublicClient({
      chain: base,
      transport: http(BASE_RPC_URL, {
        fetchFn: (url, init) => compressModule(url, init, 'gzip'),
      }),
    });
    const block = await retry2(() => client.getBlockNumber());
    expect(block).toBeGreaterThan(0n);
  });

  test('deflate', async () => {
    const client = createPublicClient({
      chain: base,
      transport: http(BASE_RPC_URL, {
        fetchFn: (url, init) => compressModule(url, init, 'deflate'),
      }),
    });
    const block = await retry2(() => client.getBlockNumber());
    expect(block).toBeGreaterThan(0n);
  });

  test('custom transform (compress_call)', async () => {
    const client = createPublicClient({
      chain: base,
      transport: http(BASE_RPC_URL, {
        fetchFn: (url, init) => compressModule(url, init, compress_call),
      }),
    });
    const block = await retry2(() => client.getBlockNumber());
    expect(block).toBeGreaterThan(0n);
  });

  test('custom transform (inline)', async () => {
    const client = createPublicClient({
      chain: base,
      transport: http(BASE_RPC_URL, {
        fetchFn: (url, init) => compressModule(url, init, (p) => p),
      }),
    });
    const block = await retry2(() => client.getBlockNumber());
    expect(block).toBeGreaterThan(0n);
  });
});
