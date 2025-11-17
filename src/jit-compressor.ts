import { LibZip } from 'solady';

const MAX_160_BIT = (1n << 160n) - 1n;

const _normHex = (hex: string): string => hex.replace(/^0x/, '').toLowerCase();

const _hexToUint8Array = (hex: string): Uint8Array => {
  const normalized = _normHex(hex);
  const len = normalized.length;
  const bytes = new Uint8Array(len / 2);
  for (let i = 0; i < len; i += 2) {
    bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
  }
  return bytes;
};

const _uint8ArrayToHex = (bytes: Uint8Array): string => {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
};

/**
 * Generates FastLZ (LZ77) decompressor bytecode. The generated code decompresses incoming calldata and forwards it to the target address.
 * @param address - Target contract address
 * @see {@link https://github.com/Vectorized/solady/blob/main/src/utils/LibZip.sol}
 * @pure
 */
//! @__PURE__
export const flzFwdBytecode = (address: string): string =>
  `0x365f73${_normHex(address)}815b838110602f575f80848134865af1503d5f803e3d5ff35b803590815f1a8060051c908115609857600190600783149285831a6007018118840218600201948383011a90601f1660081b0101808603906020811860208211021890815f5b80830151818a015201858110609257505050600201019201916018565b82906075565b6001929350829150019101925f5b82811060b3575001916018565b85851060c1575b60010160a6565b936001818192355f1a878501530194905060ba56`;

/**
 * Generates RLE (run-length encoded) decompressor bytecode. The generated code decompresses incoming calldata and forwards it to the target address.
 * @param address - Target contract address
 * @see {@link https://github.com/Vectorized/solady/blob/main/src/utils/LibZip.sol}
 * @pure
 */
//! @__PURE__
export const rleFwdBytecode = (address: string): string =>
  `0x5f5f5b368110602d575f8083813473${_normHex(address)}5af1503d5f803e3d5ff35b600180820192909160031981019035185f1a8015604c57815301906002565b505f19815282820192607f9060031981019035185f1a818111156072575b160101906002565b838101368437606a56`;

/**
 * JIT Compiles decompressor bytecode
 * @param calldata - Calldata to compress
 * @pure
 */
//! @__PURE__
export const jitBytecode = function (calldata: string): string {
  return _jitDecompressor('0x' + _normHex(calldata));
};

const _jitDecompressor = function (calldata: string): string {
  const hex = _normHex(calldata);
  const buf = _hexToUint8Array(hex);
  const n = buf.length;

  let ops: number[] = [];
  let data: (number[] | null)[] = [];
  let stack: bigint[] = [];
  let stackFreq2 = new Map<bigint, number>();
  let trackedMemSize = 0;
  let mem = new Map<number, bigint>();

  const getStackIdx = (val: bigint): number => {
    const idx = stack.lastIndexOf(val);
    return idx === -1 ? -1 : stack.length - 1 - idx;
  };

  const opFreq = new Map<number, number>();
  const dataFreq = new Map<number[] | null, number>();
  const stackFreq = new Map<bigint, number>();
  const wordCache = new Map<string, number>();
  const wordCacheCost = new Map<string, number>();
  const roundUp32 = (x: number) => (x + 31) & ~31;

  let pushCounter = 0;
  const stackCnt = new Map<bigint, number>();

  const pop2 = (): [bigint, bigint] => [stack.pop()!, stack.pop()!];
  const MASK32 = (1n << 256n) - 1n;

  const bump = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) || 0) + 1);
  const pushOp = (op: number) => {
    ops.push(op);
    bump(opFreq, op);
  };
  const pushD = (d: number[] | null) => {
    data.push(d || null);
    bump(dataFreq, d || null);
  };
  const pushS = (v: bigint) => {
    stack.push(v);
    bump(stackFreq, v);
    bump(stackFreq2, v);
    ++pushCounter;
    stackCnt.set(v, pushCounter);
  };

  const trackMem = (offset: number, size: number) => {
    trackedMemSize = roundUp32(offset + size);
  };

  const addOp = (op: number, imm?: number[]) => {
    if (op === 0x59) {
      pushS(BigInt(trackedMemSize));
    } else if (op === 0x1b) {
      // SHL
      const [shift, val] = pop2();
      pushS((val << shift) & MASK32);
    } else if (op === 0x17) {
      // OR
      const [a, b] = pop2();
      pushS((a | b) & MASK32);
    } else if ((op >= 0x60 && op <= 0x7f) || op === 0x5f) {
      // PUSH
      let v = 0n;
      for (const b of imm || []) v = (v << 8n) | BigInt(b);
      const idx = getStackIdx(v);
      pushS(v);
      if (idx !== -1 && op != 0x5f) {
        if (stackFreq2.get(v)! * 2 < stackFreq.get(v)!) {
          pushOp(128 + idx);
          pushD(null);
        }
        return;
      }
    } else if (op === 0x51) {
      // MLOAD
      const k = Number(stack.pop()!);
      pushS(mem.has(k) ? mem.get(k)! : 0n);
    } else if (op === 0x52) {
      // MSTORE
      const [offset, value] = pop2();
      const k = Number(offset);
      mem.set(k, value & MASK32);
      trackMem(k, 32);
    } else if (op === 0x53) {
      // MSTORE8
      const [offset, _] = pop2();
      trackMem(Number(offset), 1);
    } else if (op === 0xf3) {
      // RETURN
      pop2();
    }
    pushOp(op);
    pushD(imm || null);
  };

  const op = (opcode: number) => addOp(opcode);
  const pushN = (value: number | bigint) => {
    if (value > 0 && value === trackedMemSize) return addOp(0x59);
    if (!value) return addOp(0x5f, undefined); // PUSH0
    let v = BigInt(value);
    let bytes: number[] = [];
    while (v) {
      bytes.unshift(Number(v & 0xffn));
      v >>= 8n;
    }
    return addOp(0x5f + bytes.length, bytes);
  };
  const pushB = (buf: Uint8Array) => addOp(0x5f + buf.length, Array.from(buf));
  const cntWords = (hex: string, wordHex: string) =>
    (hex.match(new RegExp(wordHex, 'g')) || []).length;

  // Rough cost model
  const estShlCost = (seg: Array<{ s: number; e: number }>) => {
    let cost = 0;
    let first = true;
    for (const { s, e } of seg) {
      cost += 1 + e - s + 1; // PUSH segLen bytes
      if (31 - e > 0) cost += 1 /* PUSH1 */ + 1 /* shift byte */ + 1 /* SHL */;
      if (!first) cost += 1; // OR
      first = false;
    }
    return cost;
  };

  type PlanStep =
    | { t: 'num'; v: number | bigint }
    | { t: 'bytes'; b: Uint8Array }
    | { t: 'op'; o: number };

  const plan: PlanStep[] = [];
  const emitPushN = (v: number | bigint) => (plan.push({ t: 'num', v }), pushN(v));
  const emitPushB = (b: Uint8Array) => (plan.push({ t: 'bytes', b }), pushB(b));
  const emitOp = (o: number) => (plan.push({ t: 'op', o }), op(o));

  // First pass: decide how to build each 32-byte word without emitting bytecode
  for (let base = 0; base < n; base += 32) {
    const word = new Uint8Array(32);
    word.set(buf.slice(base, Math.min(base + 32, n)), 0);

    const seg: Array<{ s: number; e: number }> = [];
    for (let i = 0; i < 32; ) {
      while (i < 32 && word[i] === 0) ++i;
      if (i >= 32) break;
      const s = i;
      while (i < 32 && word[i] !== 0) ++i;
      seg.push({ s, e: i - 1 });
    }

    if (!seg.length) continue;

    const byte8s = seg.every(({ s, e }) => s === e);
    if (byte8s) {
      for (const { s } of seg) {
        emitPushN(word[s]);
        emitPushN(base + s);
        emitOp(0x53); // MSTORE8
      }
      continue;
    }

    // Decide whether to build this word via SHL/OR or as a single literal word
    const literal = word.slice(seg[0].s);
    const literalCost = 1 + literal.length;

    const baseBytes = Math.ceil(Math.log2(base + 1) / 8);
    const wordHex = _uint8ArrayToHex(word);
    if (literalCost > 5) {
      if (wordCache.has(wordHex)) {
        if (literalCost > wordCacheCost.get(wordHex)! + baseBytes) {
          emitPushN(wordCache.get(wordHex)!);
          emitOp(0x51);
          emitPushN(base);
          emitOp(0x52); // MSTORE
          continue;
        }
      } else if (wordCacheCost.get(wordHex) != -1) {
        const reuseCost = baseBytes + 4;
        const freq = cntWords(hex, wordHex);
        wordCacheCost.set(wordHex, freq * 32 > freq * reuseCost ? reuseCost : -1);
        wordCache.set(wordHex, base);
      }
    }

    if (literalCost <= estShlCost(seg)) {
      emitPushB(literal);
    } else {
      let first = true;
      for (const { s, e } of seg) {
        const suffix0s = 31 - e;
        emitPushB(word.slice(s, e + 1));
        if (suffix0s > 0) {
          emitPushN(suffix0s * 8);
          emitOp(0x1b); // SHL
        }
        if (!first) emitOp(0x17); // OR
        first = false;
      }
    }
    emitPushN(base);
    emitOp(0x52); // MSTORE
  }

  ops = [];
  data = [];
  stack = [];
  trackedMemSize = 0;
  mem = new Map();

  // Pre 2nd pass. Push most frequent literals into stack.
  Array.from(stackFreq.entries())
    .filter(([val, _]) => {
      return typeof val === 'number' ? val : Number(val) <= MAX_160_BIT;
    })
    .filter(([val, freq]) => freq > 1 && val !== 0n)
    .sort((a, b) => stackCnt.get(b[0])! - stackCnt.get(a[0])!)
    .slice(0, 14)
    .forEach(([val, _]) => {
      pushN(val);
    });

  stackFreq2 = new Map();

  // Second pass: emit ops and track mem/stack
  for (const step of plan) {
    if (step.t === 'num') pushN(step.v);
    else if (step.t === 'bytes') pushB(step.b);
    else if (step.t === 'op') op(step.o);
  }

  // CALL stack layout (top to bottom): gas, address, value, argsOffset, argsSize, retOffset, retSize
  //
  // Opcodes breakdown:
  // - 0x5f5f: PUSH0 PUSH0 (retSize=0, retOffset=0)
  // - pushN(n): argsSize = actual data length
  // - 0x5f: PUSH0 (argsOffset=0)
  // - 0x34: CALLVALUE (value)
  // - 0x5f35: PUSH0 CALLDATALOAD (address from calldata[0])
  // - 0x5a: GAS (remaining gas)
  // - 0xf1: CALL
  // - 0x50: POP (discard success value)
  //
  // RETURNDATACOPY(destOffset=0, offset=0, length=RETURNDATASIZE):
  // - 0x3d5f5f3e: RETURNDATASIZE PUSH0 PUSH0 RETURNDATACOPY
  //
  // RETURN(offset=0, size=RETURNDATASIZE):
  // - 0x3d5ff3: RETURNDATASIZE PUSH0 RETURN

  op(0x5f); // PUSH0 (retSize)
  op(0x5f); // PUSH0 (retOffset)
  pushN(n); // argsSize = actual data length

  const out: number[] = [];
  for (let i = 0; i < ops.length; ++i) {
    out.push(ops[i]);
    if (ops[i] >= 0x60 && ops[i] <= 0x7f && data[i]) out.push(...data[i]!);
  }

  return '0x' + _uint8ArrayToHex(new Uint8Array(out)) + '5f345f355af1503d5f5f3e3d5ff3';
};

const MIN_SIZE_FOR_COMPRESSION = 800;
const DECOMPRESSOR_ADDRESS = '0x0000000000000010000000000000000000000001';

const _jit = 'jit';
const _flz = 'flz';
const _cd = 'cd';

/**
 * Compresses eth_call payload using JIT, FastLZ (FLZ), or calldata RLE (CD) compression.
 * Auto-selects best algorithm if not specified. Only compresses if >800 bytes and beneficial.
 * @param payload - eth_call RPC payload
 * @param alg - 'jit' | 'flz' | 'cd' | undefined (auto)
 * @returns (un)compressed eth_call payload
 * @pure
 */
//! @__PURE__
export const compress_call = function (payload: any, alg?: string): any {
  const rpcMethod = payload.params?.[0]?.method || payload.method;
  if (rpcMethod && rpcMethod !== 'eth_call') return payload;

  const hex = _normHex(payload.data || '0x');
  const originalSize = (payload.data || '0x').length;
  if (originalSize < MIN_SIZE_FOR_COMPRESSION) return payload;

  const targetAddress = payload.to || '';
  const data = '0x' + hex;

  const autoSelect = !alg && originalSize < 4096;
  const flz = alg === _flz || autoSelect ? LibZip.flzCompress(data) : null;
  const cd = alg === _cd || autoSelect ? LibZip.cdCompress(data) : null;

  const selectedMethod =
    alg || (originalSize >= 4096 ? _jit : flz!.length < cd!.length ? _flz : _cd);

  let bytecode: string;
  let calldata: string;

  if (selectedMethod === _jit) {
    bytecode = _jitDecompressor(data);
    calldata = '0x' + _normHex(targetAddress).padStart(64, '0');
  } else {
    const isFlz = selectedMethod === _flz;
    calldata = isFlz ? flz! : cd!;
    bytecode = isFlz ? flzFwdBytecode(targetAddress) : rleFwdBytecode(targetAddress);
  }

  const compressedSize = bytecode.length + calldata.length;
  if (compressedSize >= originalSize) return payload;

  return {
    ...payload,
    to: DECOMPRESSOR_ADDRESS,
    data: calldata,
    stateDiff: {
      ...(payload.stateDiff || {}),
      [DECOMPRESSOR_ADDRESS]: { code: bytecode },
    },
  };
};
