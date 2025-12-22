import { spawn } from 'node:child_process';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { compressModule } from '../dist/_esm/index.node.js';
import { compress_call } from '../dist/_esm/jit-compressor.js';
import { BASE_RPC_URL, loadFixture, PROXY_URL, retry2, sleep } from './utils';

let proxyServer;

beforeAll(async () => {
  proxyServer = spawn('bun', ['test/proxy-server.ts'], {
    stdio: 'inherit',
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
});

afterAll(() => {
  if (proxyServer) proxyServer.kill();
});

afterEach(async () => {
  await sleep(100);
});

test('compressionFetch with viem - getBlockNumber', async () => {
  const client = createPublicClient({
    chain: base,
    transport: http(PROXY_URL, {
      fetchFn: compressModule,
    }),
  });

  console.log('=== REQUEST 1 ===');
  const block1 = await retry2(() => client.getBlockNumber());
  console.log('Block number:', block1);

  expect(block1).toBeGreaterThan(0n);
});

test('compressionFetch with viem - getBlock', async () => {
  const client = createPublicClient({
    chain: base,
    transport: http(PROXY_URL, {
      fetchFn: compressModule,
    }),
  });

  console.log('=== REQUEST 2 ===');
  const block2 = await retry2(() => client.getBlock({ blockTag: 'latest' }));
  console.log('Block:', block2.number);

  expect(block2.number).toBeGreaterThan(0n);
});

test('compressionFetch with public Base RPC (no compression support)', async () => {
  const client = createPublicClient({
    chain: base,
    transport: http(BASE_RPC_URL, {
      fetchFn: compressModule,
    }),
  });

  console.log('=== REQUEST 3 (no compression support) ===');
  const block3 = await retry2(() => client.getBlockNumber());
  console.log('Block number:', block3);

  expect(block3).toBeGreaterThan(0n);

  console.log('=== REQUEST 4 (no compression support) ===');
  const block4 = await retry2(() => client.getBlock({ blockTag: 'latest' }));
  console.log('Block:', block4.number);

  expect(block4.number).toBeGreaterThan(0n);
});

test('eth_call JIT compression demo using compressModule + viem', async () => {
  const testData = loadFixture('36670119.raw.json');

  let bigTx = testData.transactions[0];
  for (const tx of testData.transactions) {
    if (tx.input && tx.input.length > bigTx.input.length) bigTx = tx;
  }

  const { from, to, input: data } = bigTx;
  const testPayload = {
    method: 'eth_call',
    params: [{ to, data }],
  };
  const compressed = compress_call(testPayload);
  const originalSize = data.length;

  // Check if compression was applied by looking at params[2] (state overrides)
  const stateOverrides = compressed.params?.[2];
  const decompressorOverride = stateOverrides?.['0x00000000000000000000000000000000000000e0'];
  const compressedData = compressed.params?.[0]?.data || compressed.data;

  const compressedSize = decompressorOverride
    ? decompressorOverride.code.length + compressedData.length
    : originalSize;

  let algorithm = 'none (not beneficial or too small)';
  if (decompressorOverride) {
    const bytecode = decompressorOverride.code;
    if (bytecode.endsWith('345f355af13d5f5f3e3d5ff3')) {
      algorithm = 'JIT';
    } else if (bytecode.startsWith('0x365f73')) {
      algorithm = 'FastLZ (FLZ)';
    } else if (bytecode.startsWith('0x5f5f5b')) {
      algorithm = 'Calldata RLE (CD)';
    }
  }

  console.log('\n=== JIT Compression Stats ===');
  console.log('Algorithm selected:', algorithm);
  console.log('Original calldata size:', originalSize, 'bytes');
  console.log('After compression:', compressedSize, 'bytes');
  console.log('Compression ratio:', ((compressedSize / originalSize) * 100).toFixed(2) + '%');

  const client = createPublicClient({
    chain: base,
    transport: http(BASE_RPC_URL, {
      fetchFn: (url, init) => compressModule(url, init, compress_call),
    }),
  });

  const result = await retry2(() =>
    client.request({
      method: 'eth_call',
      params: [
        {
          from,
          to,
          data,
        },
        '0x25F5B9C',
      ],
    }),
  );

  console.log('\nJIT DEMO eth_call RESULT:', result);

  expect(result).toMatch(/^0x[0-9a-fA-F]*$/);
});
