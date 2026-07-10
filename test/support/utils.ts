import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export { join, writeFileSync };

export const BASE_RPC_URL = 'https://mainnet.base.org';
export const PROXY_PORT = 42069;
export const PROXY_URL = `http://localhost:${PROXY_PORT}`;
export const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixture');

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function retry2<T>(fn: () => Promise<T>, delayMs = 250): Promise<T> {
  try {
    return await fn();
  } catch {
    await sleep(delayMs);
    return await fn();
  }
}

export const RPC_ENDPOINTS = [
  'https://developer-access-mainnet.base.org',
  'https://base.drpc.org',
  'https://mainnet-preconf.base.org',
];

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

export const CALLER_ADDRESS = '0x9999999999999999999999999999999999999999';
export const ECHO_CONTRACT_BYTECODE = '0x365f5f37365ff3';

export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const WETH = '0x4200000000000000000000000000000000000006';
export const DAI_BASE = '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb';
export const cbETH_BASE = '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22';

export const TEST_ADDR = [
  '0x0000000000000000000000000000000000000000',
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
  '0x3333333333333333333333333333333333333333',
  '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
];

export const normalizeCalldata = (hex: string) => '0x' + hex.replace(/^0x/, '').toLowerCase();

export const call = (address: string, abi: any, functionName: string, args?: any[]) =>
  args ? { address, abi, functionName, args } : { address, abi, functionName };

export const mockEthCall = ({
  to,
  data,
  from,
  block,
  overrides,
}: {
  to: string;
  data: string;
  from?: string;
  block?: string;
  overrides?: any;
}) => {
  const txObj = from ? { from, to, data } : { to, data };
  const params = [txObj, block || 'latest'];
  if (overrides) params.push(overrides);
  return { method: 'eth_call', params };
};

export const gen_call = (n: number) => '0x' + 'ab'.repeat(n);

export const loadFixture = (filename: string) =>
  JSON.parse(readFileSync(join(fixtureDir, filename), 'utf8'));

export const baseBlockTransactions = (minInputLength = 0) => {
  const txs: Array<{ from: string; to: string; input: string }> = [];
  for (const block of loadFixture('base-blocks.json').blocks) {
    for (const tx of Array.isArray(block.transactions) ? block.transactions : []) {
      if (tx.to && tx.input && tx.input !== '0x' && tx.input.length >= minInputLength) {
        txs.push({ from: tx.from, to: tx.to, input: tx.input });
      }
    }
  }
  return txs;
};

let endpointIndex = 0;
export function getNextEndpoint() {
  const endpoint = RPC_ENDPOINTS[endpointIndex];
  endpointIndex = (endpointIndex + 1) % RPC_ENDPOINTS.length;
  return endpoint;
}

export function getTestCaseName(body: Buffer): string {
  try {
    const requestJson = JSON.parse(body.toString());
    const method = requestJson.method || 'unknown';
    const id = requestJson.id !== undefined ? requestJson.id : 'no-id';
    if (method === 'eth_call' && requestJson.params && requestJson.params.length >= 3) {
      const stateOverride = requestJson.params[2];
      if (stateOverride && Object.keys(stateOverride).length > 0) {
        return `eth_call_compressed_${id}`;
      }
      return `eth_call_${id}`;
    }
    return `${method}_${id}`;
  } catch {
    return `raw_${Date.now()}`;
  }
}
