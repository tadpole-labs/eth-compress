import { MAX_128_BIT, MAX_256_BIT } from './constants';
import { add, and, not, or, shl, shr, sigext, sub, xor } from './opcodes';
import { _normHex, _uint8ArrayToHex, initMemoryView, MemorySegment } from './utils';
export const DEC_ADDR = '0x00000000000000000000000000000000000000e0';

export type ForwardMode = 'call' | 'delegatecall' | 'staticcall' | 'none';

const _pad64 = (s: string) => s.padStart(64, '0'),
  _zeroW = _pad64('0'),
  _cdsizeW = _pad64('20'),
  _decW = _pad64('e0'),
  _returnSuffix = '3d5f5f3e3d5ff3',
  _revertSuffix = '3d5f5f3e3d5ffd';

export const _jitDecompressor = function (
  calldata: string,
  to: string,
  from?: string,
  forward: ForwardMode = 'call',
  revert = false,
  clean_env = false,
): { bytecode: string; calldata: string; to: string; from?: string; balance: string } {
  const fromHex = from ? _normHex(from) : null;
  const cleanEnv = clean_env || forward === 'none';

  let padding = 28,
    bestW: string | null = null,
    bestF = 0,
    originalTo = _normHex(to).padStart(16, '0'),
    fromAddr = fromHex ? BigInt('0x' + fromHex) : 96n,
    selfbalance = 2n,
    ops: number[] = [],
    data: (Uint8Array | null)[] = [],
    stack: bigint[] = [],
    trackedMemSize = 0,
    mem: bigint[] = [],
    firstPass = true;

  const view = initMemoryView(calldata, padding);
  const { wordCount } = view;

  const decAddr = 224n,
    stackFreq = new Map<bigint, number>(),
    decW = _decW,
    fromW = _pad64(fromHex ?? fromAddr.toString(16)),
    toW = _pad64(originalTo);

  for (const [w, st] of view.wordStats) {
    const f = st[0];
    if (w === _zeroW || w === _cdsizeW || w === decW || w === fromW || w === toW) continue;
    if (f > bestF) (bestF = f), (bestW = w);
  }
  if (bestW) selfbalance = BigInt('0x' + bestW);

  const roundUp32 = (x: number) => (x + 31) & ~31;

  const getStackIdx = (val: bigint): number => {
    for (let i = stack.length - 1, d = 0; d < 16 && i >= 0; --i, ++d) {
      if (stack[i] === val) return d;
    }
    return -1;
  };

  const ctr = <K>(m: Map<K, number>, k: K, delta: number) => m.set(k, (m.get(k) || 0) + delta);

  const pushOp = (op: number, d?: Uint8Array | null) => {
    ops.push(op);
    data.push(d ?? null);
    // Byte offset of next opcode in the final bytecode stream.
    // For PUSHn (0x60..0x7f), add the immediate length (n) as well.
    programCnt += BigInt(1 + (op >= 0x60 && op <= 0x7f ? op - 0x5f : 0));
  };

  const pushS = (v: bigint, freqDelta: number = 1) => {
    stack.push(v);
    if (freqDelta !== 0) ctr(stackFreq, v, freqDelta);
  };

  const pop2 = (): [bigint, bigint] => [stack.pop()!, stack.pop()!];

  const trackMem = (offset: number, size: number) => {
    trackedMemSize = roundUp32(offset + size);
  };

  let programCnt = 0n;

  const addOp = (op: number, imm?: Uint8Array) => {
    if (op === 0x80) {
      // DUP1
      pushS(stack[stack.length - 1]!, firstPass ? 0 : 1);
    }
    if (op === 0x50) stack.pop();
    if (op === 0x47) pushS(selfbalance, 0);
    if (op === 0x30) pushS(decAddr, 0);
    if (op === 0x33) pushS(fromAddr, 0);
    if (op === 0x36) pushS(32n, 0);
    if (op === 0x59) pushS(BigInt(trackedMemSize), 0);
    if (op === 0x0b) {
      // SIGNEXTEND
      const [byteSize, val] = pop2();
      pushS(sigext(byteSize, val), 1);
    }
    if (op === 0x19) {
      // NOT
      pushS(not(stack.pop()!), 0);
    }
    if (op === 0x18) {
      // XOR
      const [a, b] = pop2();
      pushS(xor(a, b), 1);
    }
    if (op === 0x16) {
      // AND
      const [a, b] = pop2();
      pushS(and(a, b), 1);
    }
    if (op === 0x17) {
      // OR
      const [a, b] = pop2();
      pushS(or(a, b), 1);
    }
    if (op === 0x01) {
      // ADD
      const [a, b] = pop2();
      pushS(add(a, b), 1);
    }
    if (op === 0x03) {
      // SUB
      const [a, b] = pop2();
      pushS(sub(b, a), 1);
    }
    if (op === 0x1b) {
      // SHL
      const [shift, val] = pop2();
      pushS(shl(shift, val), 1);
    }
    if (op === 0x1c) {
      // SHR
      const [shift, val] = pop2();
      pushS(shr(shift, val), 1);
    }
    if ((op >= 0x60 && op <= 0x7f) || op === 0x5f) {
      let v = 0n; // PUSH* and PUSH0
      for (const b of imm || []) v = (v << 8n) | BigInt(b);
      if (!cleanEnv) {
        if (v === selfbalance) {
          pushS(v, 0);
          pushOp(0x47);
          return;
        }
        if (v === decAddr) {
          pushS(v, 0);
          pushOp(0x30);
          return;
        }
        if (v === fromAddr) {
          pushS(v, 0);
          pushOp(0x33); // FROM ADDRESS
          return;
        }
        if (v === 32n) {
          pushS(v, 0);
          pushOp(0x36); // CALLDATASIZE
          return;
        }
      }
      if (v === BigInt(trackedMemSize) && v != 0n) {
        pushS(v, 0);
        pushOp(0x59);
        return;
      }
      const idx = getStackIdx(v);
      if (idx != -1 && op != 0x5f) {
        const freqDelta = firstPass ? 1 : 0;
        pushS(v, freqDelta);
        pushOp(0x80 + idx);
        return;
      }
      if (!firstPass && op !== 0x5f && v === programCnt) {
        pushS(v, 0);
        pushOp(0x58);
        return;
      }
      if (v === MAX_256_BIT) {
        pushS(v, 0);
        pushOp(0x5f); // PUSH0
        pushOp(0x19); // NOT
        return;
      }
      pushS(v, 1);
      pushOp(op, imm || null);
      return;
    }
    if (op === 0x51) {
      // MLOAD
      pushS(mem[Number(stack.pop()!) >>> 5] ?? 0n, 0);
    }
    if (op === 0x52) {
      // MSTORE
      const [offset, value] = pop2();
      const k = Number(offset);
      mem[k >>> 5] = value & MAX_256_BIT;
      trackMem(k, 32);
    }
    if (op === 0x53) {
      // MSTORE8
      const [offset, _] = pop2();
      trackMem(Number(offset), 1);
    }
    pushOp(op, imm || null);
  };

  const op = (opcode: number) => addOp(opcode);

  const bytesLen = (v: bigint): number => {
    if (v === 0n) return 0;
    let n = 0;
    let t = v < 0n ? -v : v;
    while (t > 0n) {
      ++n;
      t >>= 8n;
    }
    return n;
  };

  const pushCost = (v: bigint): number =>
    v === 0n || v === 1n || (v !== 0n && v === BigInt(trackedMemSize))
      ? 1
      : v === MAX_256_BIT
        ? 2
        : 1 + bytesLen(v);

  const pushN = (value: number | bigint) => {
    const v = typeof value === 'bigint' ? value : BigInt(value);
    if (v > 0n && v === BigInt(trackedMemSize)) return addOp(0x59);
    if (v === 0n) return addOp(0x5f);

    let tmp = v;
    const len = bytesLen(tmp);
    const bytes = new Uint8Array(len);
    for (let i = len - 1; i >= 0; --i) {
      bytes[i] = Number(tmp & 0xffn);
      tmp >>= 8n;
    }
    return addOp(0x5f + len, bytes);
  };

  const pushB = (buf: Uint8Array) => addOp(0x5f + buf.length, buf);

  type PlanStep =
    | { t: 'num'; v: number | bigint }
    | { t: 'bytes'; b: Uint8Array }
    | { t: 'op'; o: number };

  const plan: PlanStep[] = [];

  const emitPushN = (v: number | bigint) => {
    plan.push({ t: 'num', v });
    pushN(v);
  };
  const emitPushB = (b: Uint8Array) => {
    plan.push({ t: 'bytes', b });
    pushB(b);
  };
  const emitOp = (o: number) => {
    plan.push({ t: 'op', o });
    op(o);
  };

  const estShlCost = (seg: MemorySegment[]) => {
    let cost = 0;
    let first = true;
    for (let i = 0; i < seg.length; i++) {
      const se = seg[i]!;
      const s = se >>> 8,
        e = se & 0xff;
      cost += 1 + (e - s + 1); // PUSH<n> immediate bytes
      if (31 - e > 0) cost += 3; // PUSH1 shift + SHL
      if (!first) cost += 1; // OR
      first = false;
    }
    return cost;
  };

  const emitBestValueForWord = (word: Uint8Array, seg: MemorySegment[]) => {
    const literal = word.subarray(seg[0]! >>> 8);
    let literalVal = 0n;
    for (let i = 0; i < literal.length; i++) literalVal = (literalVal << 8n) | BigInt(literal[i]!);
    const literalCost = pushCost(literalVal);
    const shlCost = estShlCost(seg);
    let bestCost = literalCost;
    let bestEmit: () => void = () => emitPushB(literal);
    // Try NOT: PUSH(~x) NOT
    const notVal = not(literalVal);
    const notCost = pushCost(notVal) + 1;
    if (notCost < bestCost) {
      bestCost = notCost;
      bestEmit = () => {
        emitPushN(notVal);
        emitOp(0x19);
      };
    }

    // Try SUB: PUSH0, PUSH(x), SUB
    const subVal = sub(0n, literalVal);
    const subCost = pushCost(subVal) + 2;
    if (subCost < bestCost) {
      bestCost = subCost;
      bestEmit = () => {
        emitPushN(0);
        emitPushN(subVal);
        emitOp(0x03);
      };
    }

    // Try SIGNEXTEND
    for (let numBytes = 1; numBytes < literal.length; numBytes++) {
      const mask = (1n << BigInt(numBytes * 8)) - 1n;
      const truncated = literalVal & mask;
      const extended = sigext(BigInt(numBytes - 1), truncated);
      if (
        extended === literalVal &&
        (truncated & (1n << BigInt(numBytes * 8 - 1))) !== 0n // must be negative in that width
      ) {
        const signCost = pushCost(truncated) + 3; // PUSH + PUSH1 + SIGNEXTEND
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

    // Try SHIFT+NOT
    for (let shiftBits = 8; shiftBits <= 248; shiftBits += 8) {
      const shifted = shr(BigInt(shiftBits), literalVal);
      if (shifted === 0n) break;

      const notShifted = not(shifted);
      const reconstructed = shl(BigInt(shiftBits), notShifted);
      if (reconstructed === literalVal) {
        const shiftNotCost = pushCost(notShifted) + pushCost(BigInt(shiftBits)) + 2; // PUSH + PUSH + SHL + NOT
        if (shiftNotCost < bestCost) {
          bestCost = shiftNotCost;
          bestEmit = () => {
            emitPushN(notShifted);
            emitPushN(shiftBits);
            emitOp(0x1b);
            emitOp(0x19);
          };
        }
      }
    }
    // Try SHL/OR
    if (shlCost < bestCost) {
      bestCost = shlCost;
      bestEmit = () => {
        let first = true;
        for (let i = 0; i < seg.length; i++) {
          const se = seg[i]!;
          const s = se >>> 8,
            e = se & 0xff;
          const suffix0s = 31 - e;
          emitPushB(word.subarray(s, e + 1));
          if (suffix0s > 0) {
            emitPushN(suffix0s * 8);
            emitOp(0x1b); // SHL
          }
          if (!first) emitOp(0x17); // OR
          first = false;
        }
      };
    }
    return { literal, literalVal, bestCost, bestEmit, literalCost, shlCost };
  };

  let wordIndex = 0;
  while (wordIndex < wordCount) {
    const base = wordIndex * 32;
    const word = view.getWord(wordIndex);
    const seg = view.getSegments(wordIndex);
    if (!seg.length) {
      ++wordIndex;
      continue;
    }

    const wordHex = view.wordHexes[wordIndex]!;
    // Encode Run?
    let nextIndex = wordIndex + 1;
    while (nextIndex < wordCount) {
      const s2 = view.getSegments(nextIndex);
      if (!s2.length) break;
      if (view.wordHexes[nextIndex] !== wordHex) break;
      ++nextIndex;
    }
    const runLen = nextIndex - wordIndex;

    if (runLen >= 2) {
      const lastIndex = nextIndex - 1;
      const { bestEmit } = emitBestValueForWord(word, seg);
      // First store: keep word value on stack.
      bestEmit(); // push value
      emitOp(0x80); // DUP1 (keep value)
      emitPushN(base); // offset (MSIZE if aligned)
      emitOp(0x52); // MSTORE

      for (let j = 1; j < runLen; j++) {
        emitOp(0x80); // DUP1
        emitOp(0x59); // MSIZE
        emitOp(0x52); // MSTORE
      }
      const stats = view.wordStats.get(wordHex);
      if (stats && stats[3] <= lastIndex) {
        emitOp(0x50); // POP
      }
      wordIndex = nextIndex;
      continue;
    }

    const { literalCost, shlCost, bestCost, bestEmit } = emitBestValueForWord(word, seg);
    // Try MLOAD/MSTORE reuse
    if (literalCost > 8) {
      const stats = view.wordStats.get(wordHex);
      if (stats && stats[6] !== -1 && wordIndex > stats[2]) {
        const baseBytes = stats[4] === 0 ? 0 : (32 - Math.clz32(stats[4]) + 7) >> 3;
        if (literalCost > stats[6] + baseBytes) {
          emitPushN(stats[4]);
          emitOp(0x51); // MLOAD
          emitPushN(base);
          emitOp(0x52); // MSTORE
          ++wordIndex;
          continue;
        }
      }
    }
    let byte8s = true;
    for (let i = 0; i < seg.length; i++) {
      const se = seg[i]!;
      if (se >>> 8 !== (se & 0xff)) {
        byte8s = false;
        break;
      }
    }
    const byte8sCost = seg.length * 3; // PUSH1(value), PUSH1(offset), MSTORE8
    if (byte8s && byte8sCost < bestCost && byte8sCost <= shlCost) {
      for (let i = 0; i < seg.length; i++) {
        const s = seg[i]! >>> 8;
        emitPushN(word[s]);
        emitPushN(base + s);
        emitOp(0x53); // MSTORE8
      }
      ++wordIndex;
      continue;
    }
    // Default
    bestEmit();
    emitPushN(base);
    emitOp(0x52); // MSTORE
    ++wordIndex;
  }

  //2nd pass: preseed dictionary + emit final ops
  ops = [];
  data = [];
  stack = [];
  trackedMemSize = 0;
  mem = [];
  firstPass = false;
  programCnt = 0n;

  const pre: { val: bigint; uses: number; net: number; p: number }[] = [];
  for (const [val, uses] of stackFreq) {
    if (
      uses > 1 &&
      val !== 0n &&
      val !== 32n &&
      val !== selfbalance &&
      val !== decAddr &&
      val !== fromAddr &&
      val <= MAX_128_BIT
    ) {
      const p = pushCost(val);
      const net = uses * (p - 1) - p;
      if (net > 0) pre.push({ val, uses, net, p });
    }
  }

  pre.sort((a, b) => b.net - a.net || b.uses - a.uses || a.p - b.p);
  for (let i = 0; i < 15 && i < pre.length; ++i) pushN(pre[i]!.val);

  for (const step of plan) {
    if (step.t === 'num') pushN(step.v);
    else if (step.t === 'bytes') pushB(step.b);
    else if (step.t === 'op') op(step.o);
  }

  let suffix = '';
  if (forward === 'none') {
    pushN(view.dataLength);
    pushN(padding);
    op(revert ? 0xfd : 0xf3); // REVERT or RETURN the decompressed memory
  } else {
    // Stack: retSize=0, retOffset=0, argsSize, argsOffset
    op(0x5f); // PUSH0 (retSize)
    op(0x5f); // PUSH0 (retOffset)
    pushN(view.dataLength); // argsSize
    pushN(padding); // argsOffset
    if (forward === 'call') {
      // CALLVALUE PUSH0 CALLDATALOAD GAS CALL
      suffix = '345f355af1';
    } else if (forward === 'delegatecall') {
      // PUSH0 CALLDATALOAD GAS DELEGATECALL (no value param)
      suffix = '5f355af4';
    } else {
      // PUSH0 CALLDATALOAD GAS STATICCALL (no value param)
      suffix = '5f355afa';
    }
    suffix += revert ? _revertSuffix : _returnSuffix;
  }

  let outLen = ops.length;

  for (let i = 0; i < ops.length; ++i)
    if (ops[i] >= 0x60 && ops[i] <= 0x7f && data[i]) outLen += data[i]!.length;

  const out = new Uint8Array(outLen);

  for (let i = 0, o = 0; i < ops.length; ++i) {
    out[o++] = ops[i]!;
    if (ops[i] >= 0x60 && ops[i] <= 0x7f && data[i]) out.set(data[i]!, o), (o += data[i]!.length);
  }

  const bytecode = '0x' + _uint8ArrayToHex(out) + suffix;
  const calldataOut = '0x' + _pad64(originalTo);
  const fromOut = cleanEnv
    ? fromHex
      ? fromHex.padStart(40, '0')
      : undefined
    : fromAddr.toString(16).padStart(40, '0');
  const balanceOut = cleanEnv ? '0' : selfbalance.toString(16);

  return {
    bytecode,
    calldata: calldataOut,
    to: DEC_ADDR,
    from: fromOut,
    balance: balanceOut,
  };
};
