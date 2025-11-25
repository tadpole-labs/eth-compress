import { LibZip } from 'solady';

const MAX_128_BIT = (1n << 128n) - 1n;
const MAX_256_BIT = (1n << 256n) - 1n;

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

const not = (a: bigint): bigint => ~a & MAX_256_BIT;
const and = (a: bigint, b: bigint): bigint => a & b & MAX_256_BIT;
const or = (a: bigint, b: bigint): bigint => (a | b) & MAX_256_BIT;
const xor = (a: bigint, b: bigint): bigint => (a ^ b) & MAX_256_BIT;
const shl = (shift: bigint, value: bigint): bigint => (value << shift) & MAX_256_BIT;
const shr = (shift: bigint, value: bigint): bigint => (value >> shift) & MAX_256_BIT;
const sub = (a: bigint, b: bigint): bigint => (a - b) & MAX_256_BIT;
const sigext = (byteSize: bigint, value: bigint): bigint => {
  const numBytes = Number(byteSize) + 1;
  const mask = (1n << BigInt(numBytes * 8)) - 1n;
  const signBit = 1n << BigInt(numBytes * 8 - 1);
  const maskedVal = value & mask;
  const extended = maskedVal & signBit ? maskedVal | (~mask & MAX_256_BIT) : maskedVal;
  return extended & MAX_256_BIT;
};

/**
 * Generates FastLZ (LZ77) decompressor bytecode. The generated code decompresses incoming calldata and forwards it to the target address.
 * @param address - Target contract address
 * @see {@link https://github.com/Vectorized/solady/blob/main/src/utils/LibZip.sol}
 * @pure
 */
//! @__PURE__
const flzFwdBytecode = (address: string): string =>
  `0x365f73${_normHex(address)}815b838110602f575f80848134865af1503d5f803e3d5ff35b803590815f1a8060051c908115609857600190600783149285831a6007018118840218600201948383011a90601f1660081b0101808603906020811860208211021890815f5b80830151818a015201858110609257505050600201019201916018565b82906075565b6001929350829150019101925f5b82811060b3575001916018565b85851060c1575b60010160a6565b936001818192355f1a878501530194905060ba56`;

/**
 * Generates RLE (run-length encoded) decompressor bytecode. The generated code decompresses incoming calldata and forwards it to the target address.
 * @param address - Target contract address
 * @see {@link https://github.com/Vectorized/solady/blob/main/src/utils/LibZip.sol}
 * @pure
 */
//! @__PURE__
const rleFwdBytecode = (address: string): string =>
  `0x5f5f5b368110602d575f8083813473${_normHex(address)}5af1503d5f803e3d5ff35b600180820192909160031981019035185f1a8015604c57815301906002565b505f19815282820192607f9060031981019035185f1a818111156072575b160101906002565b838101368437606a56`;

const _jitDecompressor = function (calldata: string): string {
  const hex = _normHex(calldata);
  const originalBuf = _hexToUint8Array(hex);

  // Right‑align the 4‑byte selector in the first 32‑byte slot (offset 28),
  // so that everything after the selector is reconstructed on mostly
  // word‑aligned boundaries. This keeps the ABI words (and therefore most
  // calldata reconstruction) 32‑byte aligned in memory.
  // That way we avoid encoding offsets for writes (most of the time),
  const padding = 28;
  const buf = new Uint8Array(padding + originalBuf.length);
  buf.set(originalBuf, padding);

  const n = buf.length;

  let ops: number[] = [];
  let data: (number[] | null)[] = [];
  let stack: bigint[] = [];
  let trackedMemSize = 0;
  let mem = new Map<number, bigint>();
  let firstPass = true;
  const getStackIdx = (val: bigint): number => {
    let idx = stack.lastIndexOf(val);
    idx = idx === -1 ? -1 : stack.length - 1 - idx;
    return idx > 15 ? -1 : idx;
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

  const ctr = <K>(m: Map<K, number>, k: K, delta: number) => m.set(k, (m.get(k) || 0) + delta);
  const inc = <K>(m: Map<K, number>, k: K) => ctr(m, k, 1);
  const dec = <K>(m: Map<K, number>, k: K) => ctr(m, k, -1);
  const pushOp = (op: number) => {
    ops.push(op);
    inc(opFreq, op);
  };
  const pushD = (d: number[] | null) => {
    data.push(d || null);
    inc(dataFreq, d || null);
  };
  const pushS = (v: bigint, freq: number = 1) => {
    stack.push(v);
    ctr(stackFreq, v, freq);
    ++pushCounter;
    stackCnt.set(v, pushCounter);
  };

  const trackMem = (offset: number, size: number) => {
    trackedMemSize = roundUp32(offset + size);
  };

  const addOp = (op: number, imm?: number[]) => {
    if (op === 0x36) {
      pushS(32n, 0);
    } else if (op === 0x59) {
      pushS(BigInt(trackedMemSize), 0);
    } else if (op === 0x0b) {
      // SIGNEXTEND
      const [byteSize, val] = pop2();
      pushS(sigext(byteSize, val), 1);
    } else if (op === 0x19) {
      // NOT
      const val = stack.pop()!;
      pushS(not(val), 0);
    } else if (op === 0x18) {
      // XOR
      const [a, b] = pop2();
      pushS(xor(a, b), 1);
    } else if (op === 0x16) {
      // AND
      const [a, b] = pop2();
      pushS(and(a, b), 1);
    } else if (op === 0x03) {
      // SUB
      const [a, b] = pop2();
      pushS(sub(a, b), 1);
    } else if (op === 0x1b) {
      // SHL
      let [shift, val] = pop2();
      pushS(shl(shift, val), 1);
    } else if (op === 0x1c) {
      // SHR
      let [shift, val] = pop2();
      pushS(shr(shift, val), 1);
    } else if (op === 0x17) {
      // OR
      let [a, b] = pop2();
      pushS(or(a, b), 1);
    } else if ((op >= 0x60 && op <= 0x7f) || op === 0x5f) {
      // PUSH
      let v = 0n;
      for (const b of imm || []) v = (v << 8n) | BigInt(b);
      if (v == 224n) {
        pushS(v, 0);
        pushOp(0x30); // ADDRESS
        pushD(null);
        return;
      }
      if (v == 32n) {
        pushS(v, 0);
        pushOp(0x36); // ADDRESS
        pushD(null);
        return;
      }
      if (v === BigInt(trackedMemSize)) {
        pushS(v, 0);
        pushOp(0x59); // MemSize
        pushD(null);
        return;
      }
      const idx = getStackIdx(v);
      if (idx !== -1 && op != 0x5f) {
        let pushCtr = firstPass ? 1 : -1;
        pushS(v, pushCtr);
        pushOp(128 + idx);
        pushD(null);
        return;
      }
      if (v == MAX_256_BIT) {
        pushS(v);
        pushOp(0x5f); // 0
        pushOp(0x19); // NOT
        pushD(null);
        pushD(null);
        return;
      }
      pushS(v);
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
    if (value == 32n) return addOp(0x36);
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
  pushN(1n);
  // First pass: decide how to build each 32-byte word without emitting bytecode
  const _stack = [1n, 32n, 224n];
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

    // Decide whether to build this word via SHL/OR or as a single literal word
    const literal = word.slice(seg[0].s);
    const literalCost = 1 + literal.length;
    let literalVal = 0n;
    for (const b of literal) literalVal = (literalVal << 8n) | BigInt(b);
    const baseBytes = Math.ceil(Math.log2(base + 1) / 8);
    const wordHex = _uint8ArrayToHex(word);
    const shlCost = estShlCost(seg);

    const inStack = _stack.includes(literalVal);
    if (inStack) {
      emitPushB(literal);
      emitPushN(base);
      emitOp(0x52); // MSTORE
      continue;
    }
    if (literalCost > 8) {
      if (wordCache.has(wordHex)) {
        if (literalCost > wordCacheCost.get(wordHex)! + baseBytes) {
          emitPushN(wordCache.get(wordHex)!);
          emitOp(0x51);
          emitPushN(base);
          emitOp(0x52); // MSTORE
          continue;
        }
      } else if (wordCacheCost.get(wordHex) != -1) {
        const reuseCost = baseBytes + 3;
        const freq = cntWords(hex, wordHex);
        wordCacheCost.set(wordHex, freq * 32 > freq * reuseCost ? reuseCost : -1);
        wordCache.set(wordHex, base);
      }
    }

    const byte8s = seg.every(({ s, e }) => s === e);
    const byte8sCost = seg.length * 3; // each: PUSH1 (value), PUSH1 (offset), MSTORE8
    if (inStack) {
      emitPushB(literal);
    } else {
      // Aggregate all costs
      let bestCost = literalCost;
      let bestEmit: (() => void) | null = () => {
        emitPushB(literal);
      };
      if (literalVal == MAX_256_BIT) {
        bestCost = 2;
        bestEmit = () => {
          emitPushN(notVal);
          emitOp(0x19);
        };
      }
      // Try NOT: PUSH<n> ~val, NOT
      const notVal = not(literalVal);
      let notBytes = 0;
      let tmp = notVal;
      while (tmp > 0n) {
        notBytes++;
        tmp >>= 8n;
      }
      notBytes = 1 + notBytes;
      if (notBytes === 0) notBytes;
      const notCost = notBytes + 1; // PUSH<n> + NOT
      if (notCost < bestCost) {
        bestCost = notCost;
        bestEmit = () => {
          emitPushN(notVal);
          emitOp(0x19);
        };
      }

      // Try SUB: PUSH1 0, PUSH<n> val, SUB
      const subVal = sub(0n, literalVal);
      let subBytes = 0;
      tmp = subVal;
      while (tmp > 0n) {
        subBytes++;
        tmp >>= 8n;
      }
      if (subBytes === 0) subBytes = 1;
      if (_stack.includes(subVal)) subBytes = 1;
      const subCost = 1 + (1 + subBytes) + 1; // PUSH0 + PUSH<n> + SUB
      if (subCost < bestCost) {
        bestCost = subCost;
        bestEmit = () => {
          emitPushN(0);
          emitPushN(subVal);
          emitOp(0x03);
        };
      }

      // Try SIGNEXTEND: PUSH<n> truncated, PUSH1 byteSize, SIGNEXTEND
      for (let numBytes = 1; numBytes < literal.length; numBytes++) {
        const mask = (1n << BigInt(numBytes * 8)) - 1n;
        const truncated = literalVal & mask;
        const extended = sigext(BigInt(numBytes - 1), truncated);
        if (extended === literalVal && (truncated & (1n << BigInt(numBytes * 8 - 1))) !== 0n) {
          let trueByteCost = 1 + numBytes;
          if (_stack.includes(BigInt(extended))) trueByteCost = 1;
          let signCost = trueByteCost + (1 + 1) + 1; // PUSH<n> + PUSH1 + SIGNEXTEND
          if (signCost < bestCost) {
            bestCost = signCost;
            bestEmit = () => {
              emitPushN(truncated);
              emitPushN(numBytes - 1);
              emitOp(0x0b);
            };
          }
          break;
        }
      }

      // Try SHIFT+NOT: PUSH<n> val, PUSH1 shift, SHL, NOT
      for (let shiftBits = 8; shiftBits <= 248; shiftBits += 8) {
        const shifted = shr(BigInt(shiftBits), literalVal);
        if (shifted === 0n) break;

        const notShifted = not(shifted);
        const reconstructed = shl(BigInt(shiftBits), notShifted);

        if (reconstructed === literalVal) {
          let shiftedBytes = 0;
          let tmpShifted = notShifted;
          while (tmpShifted > 0n) {
            shiftedBytes++;
            tmpShifted >>= 8n;
          }
          if (shiftedBytes === 0) shiftedBytes = 1;
          const shiftNotCost = 1 + shiftedBytes + 2 + 1 + 1; // PUSH<n> + PUSH1 + SHL + NOT
          if (shiftNotCost < bestCost) {
            bestCost = shiftNotCost;
            bestEmit = () => {
              emitPushN(notShifted);
              emitPushN(shiftBits);
              emitOp(0x1b); // SHL
              emitOp(0x19); // NOT
            };
          }
        }
      }

      if (byte8s && byte8sCost < bestCost && byte8sCost <= shlCost) {
        for (const { s } of seg) {
          emitPushN(word[s]);
          emitPushN(base + s);
          emitOp(0x53); // MSTORE8
        }
        continue; // Skip the single MSTORE at the end
      } else if (shlCost < bestCost) {
        // Use SHL/OR
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
      } else {
        bestEmit!();
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
    .filter(([val, freq]) => freq > 1 && val > 1n && val !== 32n && val !== 224n)
    .sort((a, b) => stackCnt.get(b[0])! - stackCnt.get(a[0])!)
    .filter(([val, _]) => {
      return typeof val === 'number' ? BigInt(val) : val <= MAX_128_BIT;
    })
    .slice(0, 15)
    .forEach(([val, _]) => {
      pushN(val);
    });
  pushN(1n);
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
  // - pushN(originalBuf.length): argsSize = actual data length
  // - pushN(padding): argsOffset (skip leading alignment bytes)
  // - 0x34: CALLVALUE (value)
  // - 0x5f35: PUSH0 CALLDATALOAD (address from calldata[0])
  // - 0x5a: GAS (remaining gas)
  // - 0xf1: CALL
  //
  // RETURNDATACOPY(destOffset=0, offset=0, length=RETURNDATASIZE):
  // - 0x3d5f5f3e: RETURNDATASIZE PUSH0 PUSH0 RETURNDATACOPY
  //
  // RETURN(offset=0, size=RETURNDATASIZE):
  // - 0x3d5ff3: RETURNDATASIZE PUSH0 RETURN

  op(0x5f); // PUSH0 (retSize)
  op(0x5f); // PUSH0 (retOffset)
  pushN(originalBuf.length); // argsSize = actual data length
  pushN(padding); // argsOffset = padding

  const out: number[] = [];
  for (let i = 0; i < ops.length; ++i) {
    out.push(ops[i]);
    if (ops[i] >= 0x60 && ops[i] <= 0x7f && data[i]) out.push(...data[i]!);
  }

  // - CALLVALUE, load target address from calldata[0], GAS, CALL
  // - RETURNDATACOPY(0, 0, RETURNDATASIZE)
  // - RETURN(0, RETURNDATASIZE)
  return '0x' + _uint8ArrayToHex(new Uint8Array(out)) + '345f355af13d5f5f3e3d5ff3';
};

const MIN_SIZE_FOR_COMPRESSION = 1150;
const DECOMPRESSOR_ADDRESS = '0x00000000000000000000000000000000000000e0';
const MULTICALL3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11';

/**
 * Compresses eth_call payload using JIT, FastLZ (FLZ), or calldata RLE (CD) compression.
 * Auto-selects best algorithm if not specified. Only compresses if >800 bytes and beneficial.
 *
 * Only applies compression to calls that:
 * - target the latest block ID
 * - have no state overrides
 * - have a target address and calldata
 * - have no other properties (nonce, gas, etc.)
 *
 * @param payload - eth_call RPC payload
 * @param alg - 'jit' | 'flz' | 'cd' | undefined (auto)
 * @returns (un)compressed eth_call payload
 * @pure
 */
//! @__PURE__
export const compress_call = function (payload: any, alg?: string): any {
  const { method, params } = payload;
  if (method && method !== 'eth_call') return payload;
  const txObj = params?.[0] || payload;
  const blockParam = params?.[1];
  const overrides = params?.[2];

  // Validation
  if (
    (blockParam && blockParam !== 'latest') ||
    (overrides &&
      Object.keys(overrides).some((k) => k.toLowerCase() !== MULTICALL3_ADDRESS.toLowerCase())) ||
    !txObj?.to ||
    !txObj?.data ||
    Object.keys(txObj).some((k) => !['to', 'data', 'from'].includes(k))
  ) {
    return payload;
  }

  const originalSize = txObj.data.length;
  if (originalSize < MIN_SIZE_FOR_COMPRESSION) return payload;

  const inputData = '0x' + _normHex(txObj.data);
  const to = txObj.to;

  // Determine compression method and generate bytecode/calldata
  let bytecode: string;
  let calldata: string;

  if (alg === 'jit' || (!alg && (originalSize < 3000 || originalSize >= 8000))) {
    bytecode = _jitDecompressor(inputData);
    calldata = '0x' + _normHex(to).padStart(64, '0');
  } else {
    // Need FLZ and/or CD compression
    const flzData = alg === 'flz' || !alg ? LibZip.flzCompress(inputData) : null;
    const cdData = alg === 'cd' || (!alg && flzData) ? LibZip.cdCompress(inputData) : null;

    // Pick the best or requested one
    const useFlz =
      alg === 'flz' || (!alg && flzData && (!cdData || flzData.length < cdData.length));

    if (useFlz) {
      calldata = flzData!;
      bytecode = flzFwdBytecode(to);
    } else {
      calldata = cdData!;
      bytecode = rleFwdBytecode(to);
    }
  }

  // Skip if not beneficial
  if (bytecode.length + calldata.length >= originalSize) return payload;

  return {
    ...payload,
    params: [
      { ...txObj, to: DECOMPRESSOR_ADDRESS, data: calldata },
      blockParam || 'latest',
      { ...overrides, [DECOMPRESSOR_ADDRESS]: { code: bytecode } },
    ],
  };
};
