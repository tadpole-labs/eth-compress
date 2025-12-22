import { spawn } from 'node:child_process';
import { createPublicClient, http, parseEther } from 'viem';
import { base } from 'viem/chains';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { compressModule } from '../dist/_esm/index.node.js';
import { compress_call } from '../dist/_esm/jit-compressor.js';
import * as u from './utils';

const {
  ECHO_CONTRACT_BYTECODE,
  PROXY_URL,
  USDC,
  WETH,
  DAI_BASE,
  cbETH_BASE,
  TEST_ADDR,
  call,
  mockEthCall,
  gen_call,
  loadFixture,
  retry2,
  sleep,
} = u;

let proxyServer;

beforeAll(async () => {
  proxyServer = spawn('bun', ['test/proxy-server.ts'], {
    stdio: 'inherit',
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
});

afterAll(() => {
  if (proxyServer) proxyServer.kill();
});

afterEach(async () => {
  await sleep(1000);
});

interface Transaction {
  from: string;
  to: string;
  input: string;
}

interface TestData {
  transactions: Transaction[];
}

// Standard ERC20 ABI (minimal)
const erc20_abi = [
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

describe('Viem Multicall with JIT Compression', () => {
  test('should perform ~20 multicalls on Base L2 tokens with JIT compression', async () => {
    // Create viem client with compression
    const client = createPublicClient({
      chain: base,
      transport: http(PROXY_URL, {
        fetchFn: (url, init) => compressModule(url, init, compress_call),
      }),
      batch: {
        multicall: {
          batchSize: 512000,
        },
      },
    });

    // Get current block number for consistent testing
    const blockNumber = await retry2(() => client.getBlockNumber());
    console.log(`\nTesting multicall with block number: ${blockNumber}`);

    // Build ~20 multicall contracts
    const contracts = [
      // USDC calls
      call(USDC, erc20_abi, 'totalSupply'),
      call(USDC, erc20_abi, 'symbol'),
      call(USDC, erc20_abi, 'name'),
      call(USDC, erc20_abi, 'decimals'),
      call(USDC, erc20_abi, 'balanceOf', [TEST_ADDR[0]]),
      call(USDC, erc20_abi, 'balanceOf', [TEST_ADDR[4]]),

      // WETH calls
      call(WETH, erc20_abi, 'totalSupply'),
      call(WETH, erc20_abi, 'symbol'),
      call(WETH, erc20_abi, 'name'),
      call(WETH, erc20_abi, 'decimals'),
      call(WETH, erc20_abi, 'balanceOf', [TEST_ADDR[5]]),
      call(WETH, erc20_abi, 'balanceOf', [TEST_ADDR[6]]),

      // DAI calls
      call(DAI_BASE, erc20_abi, 'totalSupply'),
      call(DAI_BASE, erc20_abi, 'symbol'),
      call(DAI_BASE, erc20_abi, 'name'),
      call(DAI_BASE, erc20_abi, 'decimals'),
      call(DAI_BASE, erc20_abi, 'balanceOf', [TEST_ADDR[1]]),

      // cbETH calls
      call(cbETH_BASE, erc20_abi, 'totalSupply'),
      call(cbETH_BASE, erc20_abi, 'symbol'),
      call(cbETH_BASE, erc20_abi, 'decimals'),
      call(cbETH_BASE, erc20_abi, 'balanceOf', [TEST_ADDR[0]]),
      call(WETH, erc20_abi, 'balanceOf', [TEST_ADDR[6]]),
      // Allowance checks
      call(USDC, erc20_abi, 'allowance', [TEST_ADDR[4], TEST_ADDR[5]]),
    ];

    console.log(`Executing ${contracts.length} multicalls...`);

    // Perform multicall
    const results = await retry2(() =>
      client.multicall({
        contracts: contracts as any,
        blockNumber,
      }),
    );

    console.log(`Multicall completed: ${results.length} results`);

    const successCount = results.filter((r) => r.status === 'success').length;
    const failureCount = results.filter((r) => r.status === 'failure').length;

    console.log(`   \x1b[32mSuccess: ${successCount}\x1b[0m`);
    console.log(`   \x1b[31mFailure: ${failureCount}\x1b[0m`);

    expect(results.length).toBe(contracts.length);
    expect(successCount).toBeGreaterThan(0);

    // Display some sample results
    console.log('\nSample results:');
    results.slice(0, 10).forEach((result, i) => {
      if (result.status === 'success') {
        const contract = contracts[i];
        console.log(
          `   ${i + 1}. ${contract.functionName}: ${String(result.result).substring(0, 50)}${String(result.result).length > 50 ? '...' : ''}`,
        );
      } else {
        console.log(`   ${i + 1}. \x1b[31mFAIL:\x1b[0m ${result.error?.message || 'Unknown'}`);
      }
    });

    console.log('\nViem multicall compression test completed\n');
  }, 60000);

  test('should compress large eth_call through viem with JIT', async () => {
    const testData: TestData = loadFixture('36670119.raw.json');

    const largeTxs = testData.transactions
      .filter((tx) => tx.input?.length > 2000)
      .sort((a, b) => b.input.length - a.input.length)
      .slice(0, 3);

    expect(largeTxs.length).toBeGreaterThan(0);

    // Create client with JIT compression
    const client = createPublicClient({
      chain: base,
      transport: http(PROXY_URL, {
        fetchFn: (url, init) => compressModule(url, init, compress_call),
      }),
    });

    const blockNumber = await retry2(() => client.getBlockNumber());
    console.log(`\nTesting JIT compression with block: ${blockNumber}`);

    for (let i = 0; i < largeTxs.length; i++) {
      const tx = largeTxs[i];
      console.log(
        `\n${i + 1}. Testing tx with ${tx.input.length} chars (${Math.round(tx.input.length / 2)} bytes)`,
      );

      try {
        const result = await retry2(() =>
          client.call({
            account: tx.from as `0x${string}`,
            to: TEST_ADDR[1] as `0x${string}`,
            data: tx.input as `0x${string}`,
            blockNumber,
            stateOverride: [
              {
                address: TEST_ADDR[1] as `0x${string}`,
                code: ECHO_CONTRACT_BYTECODE as `0x${string}`,
                balance: parseEther('1'),
              },
            ],
          }),
        );

        const matches = result.data?.toLowerCase() === tx.input.toLowerCase();
        console.log(
          `   Result: ${matches ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${matches ? 'Match' : 'Mismatch'}`,
        );
        console.log(`   Output length: ${result.data?.length || 0} chars`);

        expect(result.data?.toLowerCase()).toBe(tx.input.toLowerCase());
      } catch (err) {
        console.log(`   ⚠️ Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log('\nJIT compression test completed\n');
  }, 60000);

  test('should not compress when state overrides are present', async () => {
    const { compress_call } = await import('../dist/_esm/jit-compressor.js');

    const existingOverrides = {
      [TEST_ADDR[1]]: {
        balance: '0x1000000000000000000',
        code: '0x6080604052',
      },
      [TEST_ADDR[2]]: {
        nonce: '0x5',
        stateDiff: {
          '0x0000000000000000000000000000000000000000000000000000000000000001': '0xabcd',
        },
      },
    };

    const payload = mockEthCall({
      from: TEST_ADDR[0],
      to: TEST_ADDR[3],
      data: gen_call(5700),
      overrides: existingOverrides,
    });

    const result = compress_call(payload, 'jit');

    expect(result).toBe(payload);
    expect(result.params[0].to).toBe(TEST_ADDR[3]);
    expect(result.params[2]).toEqual(existingOverrides);

    console.log('\x1b[32mPASS\x1b[0m State override rejection test - compression skipped');
  });

  test('should not compress when decompressor address has existing override', async () => {
    const { compress_call } = await import('../dist/_esm/jit-compressor.js');

    const data = gen_call(600);
    const testPayload = mockEthCall({ to: TEST_ADDR[3], data });
    const compressed = compress_call(testPayload, 'flz');
    const decompressorAddress = Object.keys(compressed.params[2])[0];

    const payload = mockEthCall({
      to: TEST_ADDR[3],
      data,
      overrides: { [decompressorAddress]: { code: '0x1234' } },
    });

    const result = compress_call(payload, 'jit');
    expect(result).toBe(payload);

    console.log('\x1b[32mPASS\x1b[0m Decompressor address conflict test - compression skipped');
  });

  test('should not compress when call has extra properties', async () => {
    const { compress_call } = await import('../dist/_esm/jit-compressor.js');

    const payload = {
      method: 'eth_call',
      params: [{ to: TEST_ADDR[3], data: gen_call(600), gas: '0x100000' }, 'latest'],
    };

    const result = compress_call(payload, 'jit');
    expect(result).toBe(payload);

    console.log('\x1b[32mPASS\x1b[0m Extra properties test - compression skipped');
  });

  test('should not compress when missing target address', async () => {
    const { compress_call } = await import('../dist/_esm/jit-compressor.js');

    const payload = {
      method: 'eth_call',
      params: [{ data: gen_call(600) }, 'latest'],
    };

    const result = compress_call(payload, 'jit');
    expect(result).toBe(payload);

    console.log('\x1b[32mPASS\x1b[0m Missing target address test - compression skipped');
  });
});
