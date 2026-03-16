import { performance } from 'node:perf_hooks';
import { compress_call } from '../dist/_esm/jit-compressor.js';
import { MIN_BODY_SIZE } from '../src/index';
import * as u from './utils';

const { runEvmBytecode } = await import('./fixture/evm-runner.js');
const {
  ECHO_CONTRACT_BYTECODE,
  CALLER_ADDRESS,
  TEST_ADDR,
  loadFixture,
  writeFileSync,
  join,
  fixtureDir,
} = u;

interface Transaction {
  from: string;
  to: string;
  input: string;
}

interface TestData {
  transactions: Transaction[];
}

const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

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
  const decompressorBalance = stateOverride[decompressorAddress].balance || '0x0';
  const txObj = payload.params[0];
  const fromAddress = txObj.from || CALLER_ADDRESS;

  // Set up both the target contract (echo) and the decompressor with its balance
  const state: any = {
    [targetAddress]: {
      code: ECHO_CONTRACT_BYTECODE,
      balance: '0',
    },
    [decompressorAddress]: {
      code: decompressorCode,
      balance: decompressorBalance,
    },
  };

  try {
    const evmResult = await runEvmBytecode(decompressorCode, txObj.data, {
      state,
      contractAddress: decompressorAddress,
      callerAddress: fromAddress,
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

  const jitT0 = performance.now();
  const jitPayload = compress_call(basePayload, 'jit');
  const jitT1 = performance.now();
  const jitCompressMs = jitT1 - jitT0;

  const flzT0 = performance.now();
  const flzPayload = compress_call(basePayload, 'flz');
  const flzT1 = performance.now();
  const flzCompressMs = flzT1 - flzT0;

  const cdT0 = performance.now();
  const cdPayload = compress_call(basePayload, 'cd');
  const cdT1 = performance.now();
  const cdCompressMs = cdT1 - cdT0;

  const payloads = {
    jit: jitPayload,
    flz: flzPayload,
    cd: cdPayload,
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
    jitCompressMs,
    flzCompressMs,
    cdCompressMs,
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

const fmtGas = (v: number) => (v >= 1000 ? (v / 1000).toFixed(2) + 'k' : v.toFixed(0));
const fmtKb = (v: number) => (v / 1000).toFixed(2) + ' kb';
const fmtRatio = (v: number) => (1 / v).toFixed(2) + 'x';

const SIZE_RANGES = [
  { label: '> 8 KB', min: 8000, max: Infinity },
  { label: '3–8 KB', min: 3000, max: 8000 },
  { label: '1.15–3 KB', min: 1150, max: 3000 },
] as const;

const summarizeResults = (results: any[], successCnt: { jit: number; flz: number; cd: number }) => {
  expect(successCnt.jit, 'All JIT transactions should pass').toBe(results.length);
  expect(successCnt.flz, 'All FLZ transactions should pass').toBe(results.length);
  expect(successCnt.cd, 'All CD transactions should pass').toBe(results.length);
  expect(results.length).toBeGreaterThan(0);

  console.log(
    `\n${results.length} txs | JIT: ${successCnt.jit} | FLZ: ${successCnt.flz} | CD: ${successCnt.cd}`,
  );
  console.log(
    '| Tx Size Range | # Txns | Avg Size | JIT Ratio | FLZ Ratio | CD Ratio | JIT Gas | FLZ Gas | CD Gas |',
  );
  console.log(
    '|---------------|--------|----------|-----------|-----------|----------|---------|---------|--------|',
  );

  for (const { label, min, max } of SIZE_RANGES) {
    const bucket = results.filter((r) => r.srcBytes >= min && r.srcBytes < max);
    if (!bucket.length) continue;

    const comp = bucket.filter(
      (r) =>
        r.jitRatio < COMPRESSION_THRESHOLD &&
        r.flzRatio < COMPRESSION_THRESHOLD &&
        r.cdRatio < COMPRESSION_THRESHOLD,
    );
    if (!comp.length) continue;

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const avgSize = avg(bucket.map((r) => r.srcBytes));
    const jitR = avg(comp.map((r) => r.jitRatio));
    const flzR = avg(comp.map((r) => r.flzRatio));
    const cdR = avg(comp.map((r) => r.cdRatio));
    const jitG = avg(comp.map((r) => Number(r.jitGasUsed)).filter(Boolean));
    const flzG = avg(comp.map((r) => Number(r.flzGasUsed)).filter(Boolean));
    const cdG = avg(comp.map((r) => Number(r.cdGasUsed)).filter(Boolean));

    console.log(
      `| ${label.padEnd(13)} | ${String(bucket.length).padStart(6)} | ${fmtKb(avgSize).padStart(8)} | ${fmtRatio(jitR).padStart(9)} | ${fmtRatio(flzR).padStart(9)} | ${fmtRatio(cdR).padStart(8)} | ${fmtGas(jitG).padStart(7)} | ${fmtGas(flzG).padStart(7)} | ${fmtGas(cdG).padStart(6)} |`,
    );
  }
};

describe('JIT Compression Test Suite', () => {
  const forwardModes = [
    { forward: 'call', revert: false, label: 'call + return' },
    { forward: 'call', revert: true, label: 'call + revert' },
    { forward: 'staticcall', revert: false, label: 'staticcall + return' },
    { forward: 'staticcall', revert: true, label: 'staticcall + revert' },
    { forward: 'delegatecall', revert: false, label: 'delegatecall + return' },
    { forward: 'delegatecall', revert: true, label: 'delegatecall + revert' },
    { forward: 'none', revert: true, label: 'none + revert (decompressed data)' },
    { forward: 'none', revert: false, label: 'none + return (decompressed data)' },
  ] as const;

  const algs = ['jit', 'flz', 'cd'] as const;

  for (const alg of algs) {
    for (const mode of forwardModes) {
      if (alg !== 'jit' && mode.forward === 'none') continue;

      const testFn = test;

      testFn(
        `${alg} forward:${mode.label}`,
        async () => {
          const testData: TestData = loadFixture('36670119.raw.json');
          const minLen = alg === 'jit' ? MIN_BODY_SIZE : MIN_BODY_SIZE * 2;
          const tx = testData.transactions.find((t) => t.to && t.input?.length > minLen);
          if (!tx) return;

          const srcCd = '0x' + tx.input.replace(/^0x/, '').toLowerCase();
          const isNone = mode.forward === 'none';

          const compressed = (compress_call as any)(
            {
              method: 'eth_call',
              params: [{ from: tx.from, to: tx.to, data: srcCd }, 'latest'],
              id: 1,
              jsonrpc: '2.0',
            },
            alg,
            mode.forward,
            mode.revert,
          );

          const stateOverride = compressed.params?.[2];
          const decompressorAddress = Object.keys(stateOverride || {}).find(
            (addr) => stateOverride[addr]?.code,
          );
          expect(decompressorAddress).toBeDefined();
          if (!decompressorAddress)
            throw new Error('Expected compressed payload with state override code');

          const decompressorCode = stateOverride[decompressorAddress].code;

          const evmOpts: any = { allowRevert: mode.revert };
          if (!isNone) {
            evmOpts.state = {
              [tx.to]: { code: ECHO_CONTRACT_BYTECODE, balance: '0' },
              [decompressorAddress]: {
                code: decompressorCode,
                balance: stateOverride[decompressorAddress].balance || '0x0',
              },
            };
            evmOpts.contractAddress = decompressorAddress;
            evmOpts.callerAddress = tx.from || CALLER_ADDRESS;
          }

          const result = await runEvmBytecode(decompressorCode, compressed.params[0].data, evmOpts);

          expect(result, 'EVM execution should not return null').not.toBeNull();
          expect(result?.returnValue?.toLowerCase()).toBe(srcCd.toLowerCase());

          if (mode.revert) {
            expect(result?.reverted, 'should revert when revert=true').toBe(true);
          } else {
            expect(result?.reverted, 'should not revert when revert=false').toBeFalsy();
          }
        },
        60000,
      );
    }
  }

  test('should perform roundtrip smoke test on latest Base blocks', async () => {
    const cached = loadFixture('base-blocks.json');
    const blocks = cached.blocks;
    const allTransactions: Transaction[] = [];
    for (const block of blocks) {
      if (block.transactions && Array.isArray(block.transactions)) {
        for (const tx of block.transactions) {
          if (tx.to && tx.input && tx.input !== '0x' && tx.input.length >= MIN_BODY_SIZE) {
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
      const failuresFile = join(fixtureDir, 'base-blocks-failures.json');
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

    summarizeResults(results, successCnt);
  }, 60000);

  test('should not compress non-eth_call methods', () => {
    const payload = {
      method: 'eth_sendTransaction',
      to: TEST_ADDR[1],
      data: '0x' + '00'.repeat(1000),
    };

    const result = compress_call(payload, 'jit');
    expect(result).toEqual(payload);
    expect(result.params?.[2]).toBeUndefined();
  });

  test('should not compress eth_call below minimum size threshold', () => {
    const payload = {
      method: 'eth_call',
      to: TEST_ADDR[1],
      data: '0x' + '00'.repeat(10),
    };

    const result = compress_call(payload, 'jit');
    expect(result).toEqual(payload);
    expect(result.params?.[2]).toBeUndefined();
  });

  test('should compress and decompress transactions correctly', async () => {
    const testData: TestData = loadFixture('36670119.raw.json');

    const txsWithCalldata = testData.transactions
      .map((tx, idx) => ({ tx, idx }))
      .filter(({ tx }) => tx.input?.length > MIN_BODY_SIZE);

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
