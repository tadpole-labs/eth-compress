// Ratio  = on-chain footprint (decompressor bytecode + compressed calldata) / original size.
// Ratios/gas are averaged only over txns all three algorithms compress to <70% of original.
import * as u from './support/index.ts';

const ALGS = ['jit', 'flz', 'cd'] as const;
type Alg = (typeof ALGS)[number];

const SIZE_RANGES = [
  { label: '> 8 KB', min: 8000, max: Infinity },
  { label: '3–8 KB', min: 3000, max: 8000 },
  { label: '1.15–3 KB', min: 1150, max: 3000 },
] as const;
const THRESHOLD = 0.7;

const fmtGas = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)}k` : v.toFixed(0));
const fmtKb = (v: number) => `${(v / 1000).toFixed(2)} kb`;
const fmtRatio = (v: number) => `${(1 / v).toFixed(2)}x`;
const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

interface Row {
  srcBytes: number;
  ratio: Record<Alg, number>;
  gas: Record<Alg, number>;
}

async function benchTx(tx: { from: string; to: string; input: string }): Promise<Row> {
  const srcCd = u.normalizeCalldata(tx.input);
  const base = u.mockEthCall({ from: tx.from, to: tx.to, data: srcCd });
  const ratio = {} as Record<Alg, number>;
  const gas = {} as Record<Alg, number>;

  for (const alg of ALGS) {
    const payload = u.compress_call(base, alg);
    const overrides = payload.params?.[2];
    const decAddr = overrides && Object.keys(overrides).find((a) => overrides[a]?.code);
    if (!decAddr) {
      ratio[alg] = 1;
      gas[alg] = 0;
      continue;
    }
    const code = overrides[decAddr].code;
    const calldata = payload.params[0].data;
    ratio[alg] = (code.length + calldata.length) / srcCd.length;

    const res = await u.runEvmBytecode(code, calldata, {
      state: {
        [tx.to]: { code: u.ECHO_CONTRACT_BYTECODE, balance: '0' },
        [decAddr]: { code, balance: overrides[decAddr].balance || '0x0' },
      },
      contractAddress: decAddr,
      callerAddress: payload.params[0].from || u.CALLER_ADDRESS,
    });
    gas[alg] = res ? Number(res.gasUsed) : 0;
  }
  return { srcBytes: srcCd.length, ratio, gas };
}

const txs = u.baseBlockTransactions(u.MIN_BODY_SIZE);
const rows: Row[] = [];
for (const tx of txs) rows.push(await benchTx(tx));

const lines = [
  '| Tx Size Range | # Txns | Avg. Tx Size | JIT Ratio | FLZ Ratio | CD Ratio | JIT Gas | FLZ Gas | CD Gas |',
  '|---|---|---|---|---|---|---|---|---|',
];
for (const { label, min, max } of SIZE_RANGES) {
  const bucket = rows.filter((r) => r.srcBytes >= min && r.srcBytes < max);
  const comp = bucket.filter((r) => ALGS.every((alg) => r.ratio[alg] < THRESHOLD));
  if (!comp.length) continue;
  const ratioCol = (alg: Alg) => fmtRatio(avg(comp.map((r) => r.ratio[alg])));
  const gasCol = (alg: Alg) => fmtGas(avg(comp.map((r) => r.gas[alg]).filter(Boolean)));
  lines.push(
    `| **${label}** | ${bucket.length} | ${fmtKb(avg(bucket.map((r) => r.srcBytes)))} | ` +
      `**${ratioCol('jit')}** | ${ratioCol('flz')} | ${ratioCol('cd')} | ` +
      `**${gasCol('jit')}** | ${gasCol('flz')} | ${gasCol('cd')} |`,
  );
}

console.log(`\n${rows.length} eligible txns; gas = TS EVM execution (EIP-2929)\n`);
console.log(lines.join('\n'));
