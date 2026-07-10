import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as u from './support/index.ts';

const ALGS = ['jit', 'flz', 'cd'] as const;
type Alg = (typeof ALGS)[number];

// Roundtrip a compressed eth_call payload through the evm
async function roundtrip(
  payload: any,
  srcCd: string,
  targetAddr: string,
  opts: { revert?: boolean; none?: boolean } = {},
) {
  const so = payload.params?.[2];
  const decAddr = so && Object.keys(so).find((a) => so[a]?.code);
  if (!decAddr) return { compressed: false, ok: true, reverted: false };

  const code = so[decAddr].code;
  const evmOpts: NonNullable<Parameters<typeof u.runEvmBytecode>[2]> = { allowRevert: opts.revert };
  if (!opts.none) {
    evmOpts.state = {
      [targetAddr]: { code: u.ECHO_CONTRACT_BYTECODE, balance: '0' },
      [decAddr]: { code, balance: so[decAddr].balance || '0x0' },
    };
    evmOpts.contractAddress = decAddr;
    evmOpts.callerAddress = payload.params[0].from || u.CALLER_ADDRESS;
  }

  const res = await u.runEvmBytecode(code, payload.params[0].data, evmOpts);
  return {
    compressed: true,
    ok: res?.returnValue?.toLowerCase() === srcCd.toLowerCase(),
    reverted: !!res?.reverted,
  };
}

let fixtureTxs: any[] | null = null;
const fixtureTx = (minLen: number): any =>
  (fixtureTxs ??= u.loadFixture('36670119.raw.json').transactions).find(
    (t: any) => t.to && t.input?.length > minLen,
  );

describe('compress_call roundtrip', () => {
  const FORWARD_MODES = [
    { forward: 'call', revert: false },
    { forward: 'call', revert: true },
    { forward: 'staticcall', revert: false },
    { forward: 'staticcall', revert: true },
    { forward: 'delegatecall', revert: false },
    { forward: 'delegatecall', revert: true },
    { forward: 'none', revert: false },
    { forward: 'none', revert: true },
  ] as const;

  // alg × forward-mode × revert: every path must compress, reconstruct the source
  // calldata exactly, and honor revert-vs-return semantics. flz/cd don't forward 'none'.
  for (const alg of ALGS) {
    for (const m of FORWARD_MODES) {
      if (alg !== 'jit' && m.forward === 'none') continue;
      const name = `${alg} ${m.forward}${m.revert ? '+revert' : ''}`;

      test(name, { timeout: 60000 }, async () => {
        // flz/cd need a larger input to beat the raw size and emit a decompressor
        const tx = fixtureTx(alg === 'jit' ? u.MIN_BODY_SIZE : u.MIN_BODY_SIZE * 2);
        if (!tx) return;

        const srcCd = u.normalizeCalldata(tx.input);
        const payload = u.mockEthCall({ from: tx.from, to: tx.to, data: srcCd });
        const compressed = u.compress_call(payload, alg, m.forward, m.revert);

        const r = await roundtrip(compressed, srcCd, tx.to, {
          revert: m.revert,
          none: m.forward === 'none',
        });

        assert.ok(r.compressed, 'expected a decompressor state override');
        assert.ok(r.ok, 'decompressed calldata should equal source');
        assert.equal(r.reverted, m.revert, `revert semantics for ${name}`);
      });
    }
  }

  // Full-corpus smoke test: every real transaction must roundtrip for all three
  // algorithms (a skipped, non-beneficial compression counts as a pass).
  const CORPORA: Record<string, () => Array<{ from: string; to: string; input: string }>> = {
    'base-blocks': () => u.baseBlockTransactions(u.MIN_BODY_SIZE),
    '36670119': () =>
      u
        .loadFixture('36670119.raw.json')
        .transactions.filter((t: any) => t.to && t.input?.length > u.MIN_BODY_SIZE)
        .map((t: any) => ({ from: t.from, to: t.to, input: t.input })),
  };

  for (const [corpus, load] of Object.entries(CORPORA)) {
    test(`all algorithms roundtrip 100%: ${corpus}`, { timeout: 120000 }, async () => {
      const txs = load();
      if (!txs.length) return;

      const pass: Record<Alg, number> = { jit: 0, flz: 0, cd: 0 };
      for (const tx of txs) {
        const srcCd = u.normalizeCalldata(tx.input);
        const base = u.mockEthCall({ from: tx.from, to: tx.to, data: srcCd });
        const results = await Promise.all(
          ALGS.map((alg) => roundtrip(u.compress_call(base, alg), srcCd, tx.to)),
        );
        ALGS.forEach((alg, i) => {
          if (results[i].ok) pass[alg]++;
        });
      }

      for (const alg of ALGS) {
        assert.equal(pass[alg], txs.length, `all ${alg} transactions should roundtrip`);
      }
    });
  }

  // Auto-select (no alg) compiles all three and keeps the smallest footprint, so it must
  // never be larger than any single forced algorithm.
  test('auto-select keeps the smallest footprint at every size', () => {
    const footprint = (payload: any, srcLen: number) => {
      const so = payload.params?.[2];
      const dec = so && Object.keys(so).find((a) => so[a]?.code);
      return dec ? so[dec].code.length + payload.params[0].data.length : srcLen;
    };
    for (const tx of u.baseBlockTransactions(u.MIN_BODY_SIZE)) {
      const srcCd = u.normalizeCalldata(tx.input);
      const base = u.mockEthCall({ from: tx.from, to: tx.to, data: srcCd });
      const auto = footprint(u.compress_call(base), srcCd.length);
      for (const alg of ALGS) {
        const forced = footprint(u.compress_call(base, alg), srcCd.length);
        assert.ok(auto <= forced, `auto ${auto} > ${alg} ${forced} (src ${srcCd.length})`);
      }
    }
  });
});
