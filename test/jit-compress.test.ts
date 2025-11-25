import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { compress_call } from '../dist/_esm/jit-compressor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const soladyModule = await import('solady');
const evmModule = await import('./fixture/evm-runner.js');
const utilsModule = await import('./utils.js');
const { LibZip } = soladyModule;
const { runEvmBytecode } = evmModule;
const { ECHO_CONTRACT_BYTECODE, ECHO_CONTRACT_ADDRESS } = utilsModule;

interface Transaction {
  from: string;
  to: string;
  input: string;
}

interface TestData {
  transactions: Transaction[];
}

const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

const CALLER_ADDRESS = '0x9999999999999999999999999999999999999999';
const COMPRESSION_THRESHOLD = 0.7;

const testMethod = async (
  payload: any,
  methodName: string,
  srcCd: string,
  txIndex: number,
  targetAddress: string,
) => {
  // Extract state override from params[2]
  const stateOverride = payload.params?.[2];
  if (!stateOverride) return { success: true, gas: 0n, reconstructed: undefined, error: undefined };

  const decompressorAddress = Object.keys(stateOverride).find((addr) => stateOverride[addr].code);
  if (!decompressorAddress)
    return { success: true, gas: 0n, reconstructed: undefined, error: undefined };

  const decompressorCode = stateOverride[decompressorAddress].code;
  const txObj = payload.params[0];

  // Set up both the target contract (echo) and any addresses from state override
  const state: any = {
    [targetAddress]: {
      code: ECHO_CONTRACT_BYTECODE,
      balance: '0',
    },
  };

  try {
    const evmResult = await runEvmBytecode(decompressorCode, txObj.data, {
      state,
      contractAddress: decompressorAddress,
      callerAddress: CALLER_ADDRESS,
    });

    if (evmResult?.returnValue) {
      const reconstructed = evmResult.returnValue.toLowerCase();
      const success = reconstructed === srcCd.toLowerCase();
      return { success, gas: evmResult.gasUsed, reconstructed, error: undefined };
    }
  } catch (err) {
    return {
      success: false,
      gas: undefined,
      reconstructed: undefined,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return { success: false, gas: undefined, reconstructed: undefined, error: 'No return value' };
};

const testTransaction = async (tx: Transaction, txIndex: number): Promise<any> => {
  const input = tx.input;
  if (!input || input === '0x' || input.length <= 2) return null;

  const hex = input.replace(/^0x/, '').toLowerCase();
  const srcCd = '0x' + hex;
  const srcBytes = srcCd.length;

  const basePayload = {
    method: 'eth_call',
    params: [
      {
        from: tx.from,
        to: tx.to,
        data: srcCd,
      },
      'latest',
    ],
    id: 1,
    jsonrpc: '2.0',
  };

  const payloads = {
    jit: compress_call(basePayload, 'jit'),
    flz: compress_call(basePayload, 'flz'),
    cd: compress_call(basePayload, 'cd'),
  };

  const extractSize = (payload: any) => {
    const stateOverride = payload.params?.[2];
    if (!stateOverride) return srcBytes;
    const decompressorCode = (Object.values(stateOverride)[0] as any).code;
    const txData = payload.params[0].data;
    return decompressorCode.length + txData.length;
  };

  const sizes = {
    jitBytes: extractSize(payloads.jit),
    flzBytes: extractSize(payloads.flz),
    cdBytes: extractSize(payloads.cd),
  };

  const results = await Promise.all([
    testMethod(payloads.jit, 'JIT', srcCd, txIndex, tx.to),
    testMethod(payloads.flz, 'FLZ', srcCd, txIndex, tx.to),
    testMethod(payloads.cd, 'CD', srcCd, txIndex, tx.to),
  ]);

  const failures: any[] = [];
  if (!results[0].success) {
    failures.push({
      algorithm: 'jit',
      expected: srcCd,
      reconstructed: results[0].reconstructed,
      error: results[0].error,
      payload: payloads.jit,
    });
  }
  if (!results[1].success) {
    failures.push({
      algorithm: 'flz',
      expected: srcCd,
      reconstructed: results[1].reconstructed,
      error: results[1].error,
      payload: payloads.flz,
    });
  }
  if (!results[2].success) {
    failures.push({
      algorithm: 'cd',
      expected: srcCd,
      reconstructed: results[2].reconstructed,
      error: results[2].error,
      payload: payloads.cd,
    });
  }

  return {
    transaction: tx,
    txIndex,
    srcBytes,
    ...sizes,
    jitRatio: sizes.jitBytes / srcBytes,
    flzRatio: sizes.flzBytes / srcBytes,
    cdRatio: sizes.cdBytes / srcBytes,
    jitRoundtripSuccess: results[0].success,
    flzRoundtripSuccess: results[1].success,
    cdRoundtripSuccess: results[2].success,
    jitGasUsed: results[0].gas,
    flzGasUsed: results[1].gas,
    cdGasUsed: results[2].gas,
    payloads,
    failures: failures.length > 0 ? failures : undefined,
  };
};

import { describe, expect, test } from 'vitest';

const summarizeResults = (
  results: any[],
  successCnt: { jit: number; flz: number; cd: number },
  opts?: { includeAvgSrcSize?: boolean },
) => {
  // For fair comparison, only consider samples where **all** algorithms
  // produced compression better than the threshold. This ensures that
  // no algorithm is advantaged by being evaluated on an easier subset.
  const comparableResults = results.filter(
    (r) =>
      r.jitRatio < COMPRESSION_THRESHOLD &&
      r.flzRatio < COMPRESSION_THRESHOLD &&
      r.cdRatio < COMPRESSION_THRESHOLD,
  );

  const jitRatios = comparableResults.map((r) => r.jitRatio);
  const flzRatios = comparableResults.map((r) => r.flzRatio);
  const cdRatios = comparableResults.map((r) => r.cdRatio);

  const jitGas = comparableResults
    .map((r) => Number(r.jitGasUsed))
    .filter((v) => v);
  const flzGas = comparableResults
    .map((r) => Number(r.flzGasUsed))
    .filter((v) => v);
  const cdGas = comparableResults
    .map((r) => Number(r.cdGasUsed))
    .filter((v) => v);

  let avgSrcSize = 0;
  if (opts?.includeAvgSrcSize) {
    const srcSizes = results.map((r) => r.srcBytes).filter((v) => v);
    avgSrcSize = mean(srcSizes);
  }

  console.log(
    `\n${results.length} txs | JIT: \x1b[32m${successCnt.jit}\x1b[0m | FLZ: \x1b[32m${successCnt.flz}\x1b[0m | CD: \x1b[32m${successCnt.cd}\x1b[0m`,
  );
  if (opts?.includeAvgSrcSize && avgSrcSize) {
    console.log(`Avg Src Size: ${avgSrcSize.toFixed(1)} bytes`);
  }
  console.log(
    `Ratio (< ${COMPRESSION_THRESHOLD * 100}% on common sample set):\n JIT ${(mean(
      jitRatios,
    ) * 100).toFixed(
      1,
    )}% (${jitRatios.length}/${results.length}) | FLZ ${(mean(flzRatios) * 100).toFixed(
      1,
    )}% (${flzRatios.length}/${results.length}) | CD ${(mean(cdRatios) * 100).toFixed(
      1,
    )}% (${cdRatios.length}/${results.length})`,
  );
  console.log(
    `Gas: JIT ${mean(jitGas).toFixed(0)} | FLZ ${mean(flzGas).toFixed(0)} | CD ${mean(
      cdGas,
    ).toFixed(0)}`,
  );

  expect(successCnt.jit, 'All JIT transactions should pass').toBe(results.length);
  expect(successCnt.flz, 'All FLZ transactions should pass').toBe(results.length);
  expect(successCnt.cd, 'All CD transactions should pass').toBe(results.length);
  expect(results.length).toBeGreaterThan(0);
};

describe('JIT Compression Test Suite', () => {
  test('should perform roundtrip smoke test on latest Base blocks', async () => {
    const blocksFile = join(__dirname, 'fixture', 'base-blocks.json');
    const cached = JSON.parse(readFileSync(blocksFile, 'utf8'));
    const blocks = cached.blocks;
    const MIN_CALLDATA_SIZE = 1150;
    const allTransactions: Transaction[] = [];
    for (const block of blocks) {
      if (block.transactions && Array.isArray(block.transactions)) {
        for (const tx of block.transactions) {
          if (tx.to && tx.input && tx.input !== '0x' && tx.input.length >= MIN_CALLDATA_SIZE) {
            allTransactions.push({
              from: tx.from,
              to: tx.to,
              input: tx.input,
            });
          }
        }
      }
    }

    if (allTransactions.length === 0) return;

    const results: any[] = [];
    const successCnt = { jit: 0, flz: 0, cd: 0 };
    const allFailures: any[] = [];

    for (let i = 0; i < allTransactions.length; i++) {
      const tx = allTransactions[i];
      const metrics = await testTransaction(tx, i);

      if (metrics) {
        results.push(metrics);
        if (metrics.jitRoundtripSuccess) successCnt.jit++;
        if (metrics.flzRoundtripSuccess) successCnt.flz++;
        if (metrics.cdRoundtripSuccess) successCnt.cd++;
        if (metrics.failures) {
          allFailures.push(...metrics.failures.map((f: any) => ({ ...f, txIndex: i })));
        }
      }
    }

    // Write failures to file if any
    if (allFailures.length > 0) {
      const failuresFile = join(__dirname, 'fixture', 'base-blocks-failures.json');
      const failureReport = {
        timestamp: new Date().toISOString(),
        totalTested: results.length,
        totalFailures: allFailures.length,
        failures: allFailures.map((f) => {
          const expectedLen = f.expected?.length || 0;
          const reconstructedLen = f.reconstructed?.length || 0;
          const lengthDiff = reconstructedLen - expectedLen;

          // Find differences between expected and reconstructed
          const differences: any[] = [];
          if (f.expected && f.reconstructed) {
            const maxLen = Math.max(expectedLen, reconstructedLen);
            let diffStart = -1;
            let diffEnd = -1;

            for (let i = 0; i < maxLen; i++) {
              if (f.expected[i] !== f.reconstructed[i]) {
                if (diffStart === -1) diffStart = i;
                diffEnd = i;
              }
            }

            if (diffStart !== -1) {
              differences.push({
                position: diffStart,
                length: diffEnd - diffStart + 1,
                expectedSegment: f.expected.slice(Math.max(0, diffStart - 20), diffEnd + 20),
                reconstructedSegment: f.reconstructed.slice(
                  Math.max(0, diffStart - 20),
                  diffEnd + 20,
                ),
              });
            }
          }

          return {
            txIndex: f.txIndex,
            algorithm: f.algorithm,
            error: f.error,
            expectedLength: expectedLen,
            reconstructedLength: reconstructedLen,
            lengthDifference: lengthDiff,
            differences,
            expected: f.expected,
            reconstructed: f.reconstructed,
            compressedPayload: f.payload,
          };
        }),
      };

      writeFileSync(failuresFile, JSON.stringify(failureReport, null, 2), 'utf8');
    }

    summarizeResults(results, successCnt, { includeAvgSrcSize: true });
  }, 60000);

  test('should not compress non-eth_call methods', () => {
    const payload = {
      method: 'eth_sendTransaction',
      to: ECHO_CONTRACT_ADDRESS,
      data: '0x' + '00'.repeat(1000),
    };

    const result = compress_call(payload, 'jit');
    expect(result).toEqual(payload);
    expect(result.params?.[2]).toBeUndefined();
  });

  test('should not compress eth_call below minimum size threshold', () => {
    const payload = {
      method: 'eth_call',
      to: ECHO_CONTRACT_ADDRESS,
      data: '0x' + '00'.repeat(10),
    };

    const result = compress_call(payload, 'jit');
    expect(result).toEqual(payload);
    expect(result.params?.[2]).toBeUndefined();
  });

  test('should compress and decompress transactions correctly', async () => {
    const testDataPath = join(__dirname, 'fixture', '36670119.raw.json');
    const testData: TestData = JSON.parse(readFileSync(testDataPath, 'utf8'));

    const txsWithCalldata = testData.transactions
      .map((tx, idx) => ({ tx, idx }))
      .filter(({ tx }) => tx.input?.length > 1150);

    const results: any[] = [];
    const successCnt = { jit: 0, flz: 0, cd: 0 };

    for (let i = 0; i < txsWithCalldata.length; i++) {
      const { tx, idx } = txsWithCalldata[i];
      const metrics = await testTransaction(tx, idx);

      if (metrics) {
        results.push(metrics);
        if (metrics.jitRoundtripSuccess) successCnt.jit++;
        if (metrics.flzRoundtripSuccess) successCnt.flz++;
        if (metrics.cdRoundtripSuccess) successCnt.cd++;
      }
    }

    summarizeResults(results, successCnt);
  }, 60000);
});

export { testTransaction };
