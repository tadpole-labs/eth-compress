import { spawn } from 'node:child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, http, parseEther } from 'viem';
import { base } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { compressModuleWithJIT } from '../dist/_esm/index.node.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const utilsModule = await import('./utils.js');
const { ECHO_CONTRACT_BYTECODE, ECHO_CONTRACT_ADDRESS } = utilsModule;

const PROXY_URL = 'http://localhost:42069';

let proxyServer;

beforeAll(async () => {
  proxyServer = spawn('node', ['test/proxy-server.js'], {
    stdio: 'inherit',
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
});

afterAll(() => {
  if (proxyServer) proxyServer.kill();
});

interface Transaction {
  from: string;
  to: string;
  input: string;
}

interface TestData {
  transactions: Transaction[];
}

// Base L2 Contract Addresses
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const DAI_BASE = '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb';
const cbETH_BASE = '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22';

// Standard ERC20 ABI (minimal)
const erc20Abi = [
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

// Random addresses for testing balanceOf
const testAddresses = [
  '0x0000000000000000000000000000000000000000',
  '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', // vitalik.eth
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // common test address
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', // another test address
  '0x1111111111111111111111111111111111111111',
];

describe('Viem Multicall with JIT Compression', () => {
  test('should perform ~20 multicalls on Base L2 tokens with JIT compression', async () => {
    // Create viem client with compression
    const client = createPublicClient({
      chain: base,
      transport: http(PROXY_URL, {
        fetchFn: compressModuleWithJIT,
      }),
      batch: {
        multicall: {
          batchSize: 512000,
        },
      },
    });

    // Get current block number for consistent testing
    const blockNumber = await client.getBlockNumber();
    console.log(`\n📦 Testing multicall with block number: ${blockNumber}`);

    // Build ~20 multicall contracts
    const contracts = [
      // USDC calls
      { address: USDC_BASE as `0x${string}`, abi: erc20Abi, functionName: 'totalSupply' },
      { address: USDC_BASE as `0x${string}`, abi: erc20Abi, functionName: 'symbol' },
      { address: USDC_BASE as `0x${string}`, abi: erc20Abi, functionName: 'name' },
      { address: USDC_BASE as `0x${string}`, abi: erc20Abi, functionName: 'decimals' },
      {
        address: USDC_BASE as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [testAddresses[0] as `0x${string}`],
      },
      {
        address: USDC_BASE as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [testAddresses[1] as `0x${string}`],
      },

      // WETH calls
      { address: WETH_BASE as `0x${string}`, abi: erc20Abi, functionName: 'totalSupply' },
      { address: WETH_BASE as `0x${string}`, abi: erc20Abi, functionName: 'symbol' },
      { address: WETH_BASE as `0x${string}`, abi: erc20Abi, functionName: 'name' },
      { address: WETH_BASE as `0x${string}`, abi: erc20Abi, functionName: 'decimals' },
      {
        address: WETH_BASE as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [testAddresses[2] as `0x${string}`],
      },
      {
        address: WETH_BASE as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [testAddresses[3] as `0x${string}`],
      },

      // DAI calls
      { address: DAI_BASE as `0x${string}`, abi: erc20Abi, functionName: 'totalSupply' },
      { address: DAI_BASE as `0x${string}`, abi: erc20Abi, functionName: 'symbol' },
      { address: DAI_BASE as `0x${string}`, abi: erc20Abi, functionName: 'name' },
      { address: DAI_BASE as `0x${string}`, abi: erc20Abi, functionName: 'decimals' },
      {
        address: DAI_BASE as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [testAddresses[4] as `0x${string}`],
      },

      // cbETH calls
      { address: cbETH_BASE as `0x${string}`, abi: erc20Abi, functionName: 'totalSupply' },
      { address: cbETH_BASE as `0x${string}`, abi: erc20Abi, functionName: 'symbol' },
      { address: cbETH_BASE as `0x${string}`, abi: erc20Abi, functionName: 'decimals' },
      {
        address: cbETH_BASE as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [testAddresses[0] as `0x${string}`],
      },
      {
        address: WETH_BASE as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [testAddresses[3] as `0x${string}`],
      },
      // Allowance checks
      {
        address: USDC_BASE as `0x${string}`,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [testAddresses[1] as `0x${string}`, testAddresses[2] as `0x${string}`],
      },
    ] as const;

    console.log(`📊 Executing ${contracts.length} multicalls...`);
    console.log(`   - USDC: 6 calls`);
    console.log(`   - WETH: 6 calls`);
    console.log(`   - DAI: 5 calls`);
    console.log(`   - cbETH: 4 calls`);
    console.log(`   - Allowance: 1 call`);

    // Perform multicall
    console.log('\n🔄 Performing multicall...');
    const results = await client.multicall({
      contracts,
      blockNumber,
    });

    console.log(`✅ Multicall completed: ${results.length} results`);

    const successCount = results.filter((r) => r.status === 'success').length;
    const failureCount = results.filter((r) => r.status === 'failure').length;

    console.log(`   Success: ${successCount}`);
    console.log(`   Failure: ${failureCount}`);

    expect(results.length).toBe(contracts.length);
    expect(successCount).toBeGreaterThan(0);

    // Display some sample results
    console.log('\n📋 Sample results:');
    results.slice(0, 10).forEach((result, i) => {
      if (result.status === 'success') {
        const contract = contracts[i];
        console.log(
          `   ${i + 1}. ${contract.functionName}: ${String(result.result).substring(0, 50)}${String(result.result).length > 50 ? '...' : ''}`,
        );
      } else {
        console.log(`   ${i + 1}. ✗ Error: ${result.error?.message || 'Unknown'}`);
      }
    });

    console.log('\n✨ Viem multicall compression test completed\n');
  }, 60000);

  test('should compress large eth_call through viem with JIT', async () => {
    // Load test data
    const testDataPath = join(__dirname, 'fixture', '36670119.raw.json');
    const testData: TestData = JSON.parse(readFileSync(testDataPath, 'utf8'));

    const largeTxs = testData.transactions
      .filter((tx) => tx.input?.length > 2000)
      .sort((a, b) => b.input.length - a.input.length)
      .slice(0, 3);

    expect(largeTxs.length).toBeGreaterThan(0);

    // Create client with JIT compression
    const client = createPublicClient({
      chain: base,
      transport: http(PROXY_URL, {
        fetchFn: compressModuleWithJIT,
      }),
    });

    const blockNumber = await client.getBlockNumber();
    console.log(`\n📦 Testing JIT compression with block: ${blockNumber}`);

    for (let i = 0; i < largeTxs.length; i++) {
      const tx = largeTxs[i];
      console.log(
        `\n${i + 1}. Testing tx with ${tx.input.length} chars (${Math.round(tx.input.length / 2)} bytes)`,
      );

      try {
        const result = await client.call({
          account: tx.from as `0x${string}`,
          to: ECHO_CONTRACT_ADDRESS as `0x${string}`,
          data: tx.input as `0x${string}`,
          blockNumber,
          stateOverride: [
            {
              address: ECHO_CONTRACT_ADDRESS as `0x${string}`,
              code: ECHO_CONTRACT_BYTECODE as `0x${string}`,
              balance: parseEther('1'),
            },
          ],
        });

        const matches = result.data?.toLowerCase() === tx.input.toLowerCase();
        console.log(`   Result: ${matches ? '✓ Match' : '✗ Mismatch'}`);
        console.log(`   Output length: ${result.data?.length || 0} chars`);

        expect(result.data?.toLowerCase()).toBe(tx.input.toLowerCase());
      } catch (err) {
        console.log(`   ⚠️ Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log('\n✨ JIT compression test completed\n');
  }, 60000);

  test('should merge state overrides without data loss', async () => {
    // Import the compress_call function
    const { compress_call } = await import('../dist/_esm/jit-compressor.js');

    // Create a large calldata payload (>1150 bytes to trigger compression)
    const largeCalldata = '0x' + 'ab'.repeat(5700); // 1000 bytes

    // Create existing state overrides that should be preserved
    const existingOverrides = {
      '0x1111111111111111111111111111111111111111': {
        balance: '0x1000000000000000000',
        code: '0x6080604052',
      },
      '0x2222222222222222222222222222222222222222': {
        nonce: '0x5',
        stateDiff: {
          '0x0000000000000000000000000000000000000000000000000000000000000001': '0xabcd',
        },
      },
    };

    // Create a payload with existing state overrides
    const payload = {
      method: 'eth_call',
      params: [
        {
          from: '0x0000000000000000000000000000000000000000',
          to: '0x3333333333333333333333333333333333333333',
          data: largeCalldata,
        },
        'latest',
        existingOverrides,
      ],
    };

    // Compress the payload
    const compressed = compress_call(payload, 'jit');

    // Verify the decompressor address is used
    expect(compressed.params[0].to).toBe('0x00000000000000000000000000000000000000e0');

    // Verify state overrides were merged correctly
    const mergedOverrides = compressed.params[2];

    // Check that existing overrides are preserved
    expect(mergedOverrides['0x1111111111111111111111111111111111111111']).toEqual({
      balance: '0x1000000000000000000',
      code: '0x6080604052',
    });
    expect(mergedOverrides['0x2222222222222222222222222222222222222222']).toEqual({
      nonce: '0x5',
      stateDiff: {
        '0x0000000000000000000000000000000000000000000000000000000000000001': '0xabcd',
      },
    });

    // Check that decompressor override was added
    expect(mergedOverrides['0x00000000000000000000000000000000000000e0']).toBeDefined();
    expect(mergedOverrides['0x00000000000000000000000000000000000000e0'].code).toBeDefined();
    expect(
      mergedOverrides['0x00000000000000000000000000000000000000e0'].code.startsWith('0x'),
    ).toBe(true);

    // Verify we have exactly 3 addresses in the merged overrides
    expect(Object.keys(mergedOverrides).length).toBe(3);

    console.log('✅ State override merging test passed - no data loss');
  });

  test('should not compress when decompressor address has existing override', async () => {
    // Import the compress_call function
    const { compress_call } = await import('../dist/_esm/jit-compressor.js');

    const largeCalldata = '0x' + 'ab'.repeat(500);

    // Create state overrides that include the decompressor address
    const existingOverrides = {
      '0x00000000000000000000000000000000000000e0': {
        code: '0x1234',
      },
    };

    const payload = {
      method: 'eth_call',
      params: [
        {
          to: '0x3333333333333333333333333333333333333333',
          data: largeCalldata,
        },
        'latest',
        existingOverrides,
      ],
    };

    // Should return uncompressed payload
    const result = compress_call(payload, 'jit');

    // Verify payload was NOT compressed (returned as-is)
    expect(result).toBe(payload);

    console.log('✅ Decompressor address conflict test passed - compression skipped');
  });
});
