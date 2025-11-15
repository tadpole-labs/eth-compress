import { existsSync, readFileSync } from 'fs';
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

const mean = (values: number[]): number | null => {
  return !values.length ? null : values.reduce((acc, v) => acc + v, 0) / values.length;
};

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const collect = (results: any[], key: string): number[] =>
  results
    .map((r) => r[key])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

const collectGas = (results: any[], key: string): number[] =>
  results
    .map((r) => r[key])
    .filter((v): v is bigint => typeof v === 'bigint')
    .map((v) => Number(v));

const extractPayloadSize = (payload: any, srcBytes: number): number => {
  return !payload.stateDiff
    ? srcBytes
    : (Object.values(payload.stateDiff)[0] as any).code.length / 2 + payload.data.length / 2;
};

const printStats = (label: string, values: number[], decimals: number = 2) => {
  if (!values.length) return;
  console.log(`\n${label}:`);
  console.log(`Average: ${mean(values)?.toFixed(decimals)}`);
  console.log(`Median:  ${median(values)?.toFixed(decimals)}`);
};

const printComparison = (label: string, valueA: number, valueB: number) => {
  const ratio = (valueA / valueB) * 100;
  const comparison = valueA < valueB ? 'better' : 'worse';
  console.log(`${label}: ${ratio.toFixed(2)}% (${comparison})`);
};

const CALLER_ADDRESS = '0x9999999999999999999999999999999999999999';

const testMethod = async (payload: any, methodName: string, srcCd: string, txIndex: number) => {
  if (!payload.stateDiff) return { success: true, gas: 0n };

  const decompressorAddress = Object.keys(payload.stateDiff)[0];
  const decompressorCode = payload.stateDiff[decompressorAddress].code;

  const state = {
    [ECHO_CONTRACT_ADDRESS]: {
      code: ECHO_CONTRACT_BYTECODE,
      balance: '0',
    },
  };

  try {
    const evmResult = await runEvmBytecode(decompressorCode, payload.data, {
      state,
      contractAddress: decompressorAddress,
      callerAddress: CALLER_ADDRESS,
    });

    if (evmResult?.returnValue) {
      const reconstructed = evmResult.returnValue.toLowerCase();
      const success = reconstructed === srcCd.toLowerCase();

      if (!success) {
        console.error(`\n${methodName} roundtrip failed for transaction ${txIndex}`);
        console.error(`Expected: ${srcCd.slice(0, 100)}...`);
        console.error(`Got:      ${reconstructed.slice(0, 100)}...`);
      }

      return { success, gas: evmResult.gasUsed };
    }
  } catch (err) {
    console.error(`\nError validating ${methodName} for transaction ${txIndex}:`, err);
  }

  return { success: false, gas: undefined };
};

const testTransaction = async (input: string, txIndex: number): Promise<any> => {
  if (!input || input === '0x' || input.length <= 2) return null;

  const hex = input.replace(/^0x/, '').toLowerCase();
  const srcCd = '0x' + hex;
  const srcBytes = hex.length / 2;

  const basePayload = { to: ECHO_CONTRACT_ADDRESS, data: srcCd };

  const payloads = {
    jit: compress_call(basePayload, 'jit'),
    flz: compress_call(basePayload, 'flz'),
    cd: compress_call(basePayload, 'cd'),
  };

  const sizes = {
    jitBytes: extractPayloadSize(payloads.jit, srcBytes),
    flzBytes: extractPayloadSize(payloads.flz, srcBytes),
    cdBytes: extractPayloadSize(payloads.cd, srcBytes),
  };

  const results = await Promise.all([
    testMethod(payloads.jit, 'JIT', srcCd, txIndex),
    testMethod(payloads.flz, 'FLZ', srcCd, txIndex),
    testMethod(payloads.cd, 'CD', srcCd, txIndex),
  ]);

  return {
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
  };
};

import { describe, expect, test } from 'vitest';

describe('JIT Compression Test Suite', () => {
  test('should not compress non-eth_call methods', () => {
    const payload = {
      method: 'eth_sendTransaction',
      to: ECHO_CONTRACT_ADDRESS,
      data: '0x' + '00'.repeat(1000),
    };

    const result = compress_call(payload, 'jit');
    expect(result).toEqual(payload);
    expect(result.stateDiff).toBeUndefined();
  });

  test('should compress and decompress transactions correctly', async () => {
    console.log('=== JIT Compression Test Suite ===\n');

    const testDataPath = join(__dirname, 'fixture', '36670119.raw.json');
    expect(existsSync(testDataPath), 'Test data file should exist').toBe(true);

    const testData: TestData = JSON.parse(readFileSync(testDataPath, 'utf8'));
    console.log(`Loaded ${testData.transactions.length} transactions from test data\n`);

    const txsWithCalldata = testData.transactions
      .map((tx, idx) => ({ tx, idx }))
      .filter(({ tx }) => tx.input?.length > 2);

    console.log(`Processing ${txsWithCalldata.length} transactions with non-empty calldata...\n`);

    const results: any[] = [];
    const successCnt = { jit: 0, flz: 0, cd: 0 };

    for (let i = 0; i < txsWithCalldata.length; i++) {
      const { tx, idx } = txsWithCalldata[i];
      const metrics = await testTransaction(tx.input, idx);

      if (metrics) {
        results.push(metrics);
        if (metrics.jitRoundtripSuccess) successCnt.jit++;
        if (metrics.flzRoundtripSuccess) successCnt.flz++;
        if (metrics.cdRoundtripSuccess) successCnt.cd++;
        process.stdout.write(`\rProcessing transaction ${i + 1}/${txsWithCalldata.length}...`);
      }
    }

    console.log('\n');

    expect(results.length, 'Should generate compression metrics').toBeGreaterThan(0);

    const formatSuccessRate = (cnt: number, total: number) =>
      `✓ ${cnt}/${total} (${((cnt / total) * 100).toFixed(2)}%)`;

    console.log('\n=== Roundtrip Validation Results (All Transactions) ===');
    console.log(`Total transactions tested: ${results.length}`);
    console.log(`JIT:  ${formatSuccessRate(successCnt.jit, results.length)}`);
    console.log(`FLZ:  ${formatSuccessRate(successCnt.flz, results.length)}`);
    console.log(`CD:   ${formatSuccessRate(successCnt.cd, results.length)}`);

    const MIN_SIZE_THRESHOLD = 800;
    const benchResults = results.filter((r) => r.srcBytes >= MIN_SIZE_THRESHOLD);

    console.log(`\n=== Size Distribution ===`);
    console.log(
      `Transactions >= ${MIN_SIZE_THRESHOLD} bytes (bench-relevant): ${benchResults.length}`,
    );
    console.log(
      `Transactions < ${MIN_SIZE_THRESHOLD} bytes (too small): ${results.length - benchResults.length}`,
    );

    console.log('\n=== Compression Statistics (bench-relevant Transactions Only) ===');
    console.log(`Transactions analyzed: ${benchResults.length}\n`);

    printStats('Original calldata size (bytes)', collect(benchResults, 'srcBytes'));
    printStats('JIT bytecode ratio (compressed / original)', collect(benchResults, 'jitRatio'), 4);
    printStats('flzCompress ratio (compressed / original)', collect(benchResults, 'flzRatio'), 4);
    printStats('cdCompress ratio (compressed / original)', collect(benchResults, 'cdRatio'), 4);

    console.log('\n=== Gas Usage Statistics (bench-relevant Transactions Only) ===');

    printStats('JIT decompression gas', collectGas(benchResults, 'jitGasUsed'), 0);
    printStats('FLZ decompression gas', collectGas(benchResults, 'flzGasUsed'), 0);
    printStats('CD decompression gas', collectGas(benchResults, 'cdGasUsed'), 0);

    const jitGas = collectGas(benchResults, 'jitGasUsed');
    const flzGas = collectGas(benchResults, 'flzGasUsed');
    const cdGas = collectGas(benchResults, 'cdGasUsed');

    if (jitGas.length && flzGas.length && cdGas.length) {
      console.log('\n=== Comparative Performance (Gas) ===');
      printComparison('JIT vs FLZ', mean(jitGas)!, mean(flzGas)!);
      printComparison('JIT vs CD', mean(jitGas)!, mean(cdGas)!);
      printComparison('FLZ vs CD', mean(flzGas)!, mean(cdGas)!);
    }

    expect(successCnt.jit, 'All JIT transactions should pass').toBe(results.length);
    expect(successCnt.flz, 'All FLZ transactions should pass').toBe(results.length);
    expect(successCnt.cd, 'All CD transactions should pass').toBe(results.length);

    console.log('\nAll transactions passed all roundtrip validations!');
  }, 60000);
});

export { testTransaction };
