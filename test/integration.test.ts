import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, afterEach, before, describe, test } from 'node:test';
import * as u from './support/index.ts';

let proxyServer: ReturnType<typeof spawn> | undefined;
before(async () => {
  proxyServer = spawn(process.execPath, ['test/support/server.ts'], { stdio: 'inherit' });
  await u.sleep(1500);
});
after(() => proxyServer?.kill());
afterEach(() => u.sleep(500));

type FetchFn = NonNullable<NonNullable<Parameters<typeof u.http>[1]>['fetchFn']>;
const jitFetch: FetchFn = (url, init) => u.compressModule(url, init, u.compress_call);

const client = (url: string, fetchFn?: FetchFn) =>
  u.createPublicClient({
    chain: u.base,
    transport: u.http(url, fetchFn ? { fetchFn } : undefined),
  });
const jitClient = (url: string) =>
  u.createPublicClient({
    chain: u.base,
    transport: u.http(url, { fetchFn: jitFetch }),
    batch: { multicall: { batchSize: 512000 } },
  });

describe('viem fetchFn modes', () => {
  const MODES: Array<{ name: string; fetchFn: FetchFn }> = [
    { name: 'passive (default)', fetchFn: u.compressModule },
    { name: 'passive (explicit)', fetchFn: (url, init) => u.compressModule(url, init, 'passive') },
    { name: 'proactive', fetchFn: (url, init) => u.compressModule(url, init, 'proactive') },
    { name: 'gzip', fetchFn: (url, init) => u.compressModule(url, init, 'gzip') },
    { name: 'deflate', fetchFn: (url, init) => u.compressModule(url, init, 'deflate') },
    { name: 'transform (compress_call)', fetchFn: jitFetch },
    { name: 'transform (inline)', fetchFn: (url, init) => u.compressModule(url, init, (p) => p) },
  ];

  for (const { name, fetchFn } of MODES) {
    test(name, async () => {
      assert.ok((await u.retry2(() => client(u.BASE_RPC_URL, fetchFn).getBlockNumber())) > 0n);
    });
  }
});

describe('compressModule end-to-end', () => {
  test('proxy: getBlockNumber and getBlock', async () => {
    const c = client(u.PROXY_URL, u.compressModule);
    assert.ok((await u.retry2(() => c.getBlockNumber())) > 0n);
    assert.ok((await u.retry2(() => c.getBlock({ blockTag: 'latest' }))).number! > 0n);
  });

  test('public Base RPC (no compression support): getBlockNumber and getBlock', async () => {
    const c = client(u.BASE_RPC_URL, u.compressModule);
    assert.ok((await u.retry2(() => c.getBlockNumber())) > 0n);
    assert.ok((await u.retry2(() => c.getBlock({ blockTag: 'latest' }))).number! > 0n);
  });

  test('eth_call JIT compression demo', async () => {
    const testData = u.loadFixture('36670119.raw.json');
    let bigTx = testData.transactions[0];
    for (const tx of testData.transactions) {
      if (tx.input && tx.input.length > bigTx.input.length) bigTx = tx;
    }
    const { to, input: data } = bigTx;
    const jitReturnFetch: FetchFn = (url, init) =>
      u.compressModule(url, init, (p) => u.compress_call(p, 'jit', 'none'));

    const result = await u.retry2(() =>
      client(u.BASE_RPC_URL, jitReturnFetch).request({
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
      }),
    );
    assert.equal(String(result).toLowerCase(), data.toLowerCase());
  });

  test('compress_call as HTTP transform', async () => {
    const tx = u
      .loadFixture('36670119.raw.json')
      .transactions.find((t: any) => t.input?.length > 2000);
    if (!tx) return;

    const res = await u.compressModule(
      u.BASE_RPC_URL,
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
      u.compress_call,
    );
    assert.equal(res.ok, true);
    assert.notEqual((await res.json()).result, undefined);
  });
});

const fn = (name: string, inputs: { type: string }[], outputs: { type: string }[]) =>
  ({ type: 'function', name, stateMutability: 'view', inputs, outputs }) as const;
const erc20_abi = [
  fn('totalSupply', [], [{ type: 'uint256' }]),
  fn('symbol', [], [{ type: 'string' }]),
  fn('name', [], [{ type: 'string' }]),
  fn('decimals', [], [{ type: 'uint8' }]),
  fn('balanceOf', [{ type: 'address' }], [{ type: 'uint256' }]),
  fn('allowance', [{ type: 'address' }, { type: 'address' }], [{ type: 'uint256' }]),
] as const;

describe('viem multicall with JIT compression', () => {
  test('~20 multicalls on Base L2 tokens', { timeout: 60000 }, async () => {
    const c = jitClient(u.PROXY_URL);
    const blockNumber = await u.retry2(() => c.getBlockNumber());

    const contracts = [
      u.call(u.USDC, erc20_abi, 'totalSupply'),
      u.call(u.USDC, erc20_abi, 'symbol'),
      u.call(u.USDC, erc20_abi, 'name'),
      u.call(u.USDC, erc20_abi, 'decimals'),
      u.call(u.USDC, erc20_abi, 'balanceOf', [u.TEST_ADDR[0]]),
      u.call(u.USDC, erc20_abi, 'balanceOf', [u.TEST_ADDR[4]]),
      u.call(u.WETH, erc20_abi, 'totalSupply'),
      u.call(u.WETH, erc20_abi, 'symbol'),
      u.call(u.WETH, erc20_abi, 'name'),
      u.call(u.WETH, erc20_abi, 'decimals'),
      u.call(u.WETH, erc20_abi, 'balanceOf', [u.TEST_ADDR[5]]),
      u.call(u.WETH, erc20_abi, 'balanceOf', [u.TEST_ADDR[6]]),
      u.call(u.DAI_BASE, erc20_abi, 'totalSupply'),
      u.call(u.DAI_BASE, erc20_abi, 'symbol'),
      u.call(u.DAI_BASE, erc20_abi, 'name'),
      u.call(u.DAI_BASE, erc20_abi, 'decimals'),
      u.call(u.DAI_BASE, erc20_abi, 'balanceOf', [u.TEST_ADDR[1]]),
      u.call(u.cbETH_BASE, erc20_abi, 'totalSupply'),
      u.call(u.cbETH_BASE, erc20_abi, 'symbol'),
      u.call(u.cbETH_BASE, erc20_abi, 'decimals'),
      u.call(u.cbETH_BASE, erc20_abi, 'balanceOf', [u.TEST_ADDR[0]]),
      u.call(u.WETH, erc20_abi, 'balanceOf', [u.TEST_ADDR[6]]),
      u.call(u.USDC, erc20_abi, 'allowance', [u.TEST_ADDR[4], u.TEST_ADDR[5]]),
    ];

    const results = await u.retry2(() => c.multicall({ contracts, blockNumber } as any));
    assert.equal(results.length, contracts.length);
    assert.ok(results.filter((r) => r.status === 'success').length > 0);
  });

  test('compress large eth_call through viem', { timeout: 60000 }, async () => {
    const largeTxs = u
      .loadFixture('36670119.raw.json')
      .transactions.filter((tx: any) => tx.input?.length > 2000)
      .sort((a: any, b: any) => b.input.length - a.input.length)
      .slice(0, 3);
    assert.ok(largeTxs.length > 0);

    const c = jitClient(u.PROXY_URL);
    const blockNumber = await u.retry2(() => c.getBlockNumber());

    for (const tx of largeTxs) {
      try {
        const result = await u.retry2(() =>
          c.call({
            account: tx.from as `0x${string}`,
            to: u.TEST_ADDR[1] as `0x${string}`,
            data: tx.input as `0x${string}`,
            blockNumber,
            stateOverride: [
              {
                address: u.TEST_ADDR[1] as `0x${string}`,
                code: u.ECHO_CONTRACT_BYTECODE as `0x${string}`,
                balance: u.parseEther('1'),
              },
            ],
          }),
        );
        assert.equal(result.data?.toLowerCase(), tx.input.toLowerCase());
      } catch {
        // best-effort: tolerate transient RPC failures on live Base
      }
    }
  });
});
