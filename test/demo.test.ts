import { spawn } from 'node:child_process';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { compressModule, compressModuleWithJIT } from '../dist/_esm/index.node.js';
import { BASE_RPC_URL } from './utils.js';

const rpcURL = 'http://localhost:42069';

let proxyServer;

beforeAll(async () => {
  proxyServer = spawn('node', ['test/proxy-server.js'], {
    stdio: 'inherit',
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
});

afterAll(() => {
  if (proxyServer) proxyServer.kill();
});

test('compressionFetch with viem - getBlockNumber', async () => {
  const client = createPublicClient({
    chain: base,
    transport: http(rpcURL, {
      fetchFn: compressModule,
    }),
  });

  console.log('=== REQUEST 1 ===');
  const block1 = await client.getBlockNumber();
  console.log('Block number:', block1);

  expect(block1).toBeGreaterThan(0n);
});

test('compressionFetch with viem - getBlock', async () => {
  const client = createPublicClient({
    chain: base,
    transport: http(rpcURL, {
      fetchFn: compressModule,
    }),
  });

  console.log('=== REQUEST 2 ===');
  const block2 = await client.getBlock({ blockTag: 'latest' });
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
  const block3 = await client.getBlockNumber();
  console.log('Block number:', block3);

  expect(block3).toBeGreaterThan(0n);

  console.log('=== REQUEST 4 (no compression support) ===');
  const block4 = await client.getBlock({ blockTag: 'latest' });
  console.log('Block:', block4.number);

  expect(block4.number).toBeGreaterThan(0n);
});

test('eth_call JIT compression demo using compressModule + viem', async () => {
  // Read test data and find the transaction with the biggest calldata
  const { readFileSync } = await import('fs');
  const { join } = await import('path');
  const { fileURLToPath } = await import('url');
  const { compress_call } = await import('../dist/_esm/jit-compressor.js');
  const testDataPath = join(
    join(fileURLToPath(import.meta.url), '..'),
    'fixture',
    '36670119.raw.json',
  );
  const testData = JSON.parse(readFileSync(testDataPath, 'utf8'));

  let bigTx = testData.transactions[0];
  for (const tx of testData.transactions) {
    if (tx.input && tx.input.length > bigTx.input.length) bigTx = tx;
  }

  const { from, to, input: data } = bigTx;
  const testPayload = { to, data, method: 'eth_call' };
  const compressed = compress_call(testPayload);
  const originalSize = data.length / 2;
  const compressedSize = compressed.stateDiff
    ? (Object.values(compressed.stateDiff)[0] as any).code.length / 2 + compressed.data.length / 2
    : originalSize;

  let algorithm = 'none (too small)';
  if (compressed.stateDiff) {
    const bytecode = (Object.values(compressed.stateDiff)[0] as any).code;
    if (bytecode.endsWith('5f345f355af1503d5f5f3e3d5ff3')) {
      algorithm = 'JIT';
    } else if (bytecode.startsWith('0x365f73')) {
      algorithm = 'FastLZ (FLZ)';
    } else if (bytecode.startsWith('5f5f5b') || bytecode.startsWith('0x5f5f5b')) {
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
      fetchFn: compressModuleWithJIT,
    }),
  });

  const result = await client.request({
    method: 'eth_call',
    params: [
      {
        from,
        to,
        data,
      },
      '0x22f8aa7',
    ],
  });

  console.log('\nJIT DEMO eth_call RESULT:', result);

  expect(result).toMatch(/^0x[0-9a-fA-F]*$/);
});
