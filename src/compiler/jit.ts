import { MAX_128_BIT, MAX_256_BIT } from './constants';
import { add, and, not, or, shl, shr, sigext, sub, xor } from './opcodes';
import { _normHex, _uint8ArrayToHex, initMemoryView, MemorySegment } from './utils';

export const _jitDecompressor = function (
  calldata: string,
  to: string,
  from?: string,
): { bytecode: string; calldata: string; to: string; from?: string; balance: string } {
  let padding = 28;
  const view = initMemoryView(calldata, padding);
  let decAddr = 224n;
  let originalTo = _normHex(to).padStart(16, '0');
  let fromAddr = from ? BigInt('0x' + _normHex(from)) : 96n;
  const excluded = new Set([0n, 32n, decAddr, fromAddr, BigInt('0x' + originalTo)]);
  let selfbalance = 2n;
  const filtered = Array.from(view.wordFreq.entries())
    .map(([word, freq]) => [BigInt('0x' + word), freq] as [bigint, number])
    .filter(([val]) => !excluded.has(val));
  if (filtered.length > 0) {
    selfbalance = filtered.reduce((max, curr) => (curr[1] > max[1] ? curr : max))[0];
  }
  const { wordCount } = view;
  let ops: number[] = [];
  let data: (number[] | null)[] = [];
  let stack: bigint[] = [];
  let trackedMemSize = 0;
  let mem = new Map<number, bigint>();
  let firstPass = true;

  const roundUp32 = (x: number) => (x + 31) & ~31;
  const getStackIdx = (val: bigint): number => {
    let idx = stack.lastIndexOf(val);
    idx = idx === -1 ? -1 : stack.length - 1 - idx;
    return idx > 15 ? -1 : idx;
  };
  const stackFreq = new Map<bigint, number>();
  const stackLastUse = new Map<bigint, number>();
  let pushCounter = 0;
  const ctr = <K>(m: Map<K, number>, k: K, delta: number) => m.set(k, (m.get(k) || 0) + delta);
  const pushOp = (op: number, d?: number[] | null) => {
    ops.push(op);
    data.push(d ?? null);
  };
  const pushS = (v: bigint, freqDelta: number = 1) => {
    stack.push(v);
    if (freqDelta !== 0) ctr(stackFreq, v, freqDelta);
    ++pushCounter;
    stackLastUse.set(v, pushCounter);
  };
  const pop2 = (): [bigint, bigint] => [stack.pop()!, stack.pop()!];
  const trackMem = (offset: number, size: number) => {
    trackedMemSize = roundUp32(offset + size);
  };

  const addOp = (op: number, imm?: number[]) => {
    if (op == 0x80) {
      // DUP1
      const val = stack[stack.length - 1]!;
      pushS(val, firstPass ? 0 : 1);
    }
    if (op == 0x50) stack.pop();
    if (op == 0x47) pushS(selfbalance, 0);
    if (op == 0x30) pushS(decAddr, 0);
    if (op == 0x33) pushS(fromAddr, 0);
    if (op == 0x36) pushS(32n, 0);
    if (op == 0x59) pushS(BigInt(trackedMemSize), 0);
    if (op === 0x0b) {
      // SIGNEXTEND
      const [byteSize, val] = pop2();
      pushS(sigext(byteSize, val), 1);
    }
    if (op == 0x19) {
      // NOT
      const val = stack.pop()!;
      pushS(not(val), 0);
    }
    if (op === 0x18) {
      // XOR
      const [a, b] = pop2();
      pushS(xor(a, b), 1);
    }
    if (op == 0x16) {
      // AND
      const [a, b] = pop2();
      pushS(and(a, b), 1);
    }
    if (op == 0x17) {
      // OR
      const [a, b] = pop2();
      pushS(or(a, b), 1);
    }
    if (op == 0x01) {
      // ADD
      const [a, b] = pop2();
      pushS(add(a, b), 1);
    }
    if (op === 0x03) {
      // SUB
      const [a, b] = pop2();
      pushS(sub(b, a), 1);
    }
    if (op == 0x1b) {
      // SHL
      const [shift, val] = pop2();
      pushS(shl(shift, val), 1);
    }
    if (op == 0x1c) {
      // SHR
      const [shift, val] = pop2();
      pushS(shr(shift, val), 1);
    }
    if ((op >= 0x60 && op <= 0x7f) || op === 0x5f) {
      let v = 0n; // PUSH* and PUSH0
      for (const b of imm || []) v = (v << 8n) | BigInt(b);
      if (v == selfbalance) {
        pushS(v, 0);
        pushOp(0x47);
        return;
      }
      if (v == decAddr) {
        pushS(v, 0);
        pushOp(0x30);
        return;
      }
      if (v == fromAddr) {
        pushS(v, 0);
        pushOp(0x33); // FROM ADDRESS
        return;
      }
      if (v == 32n) {
        pushS(v, 0);
        pushOp(0x36); // CALLDATASIZE
        return;
      }
      if (v === BigInt(trackedMemSize) && v !== 0n) {
        pushS(v, 0);
        pushOp(0x59);
        return;
      }
      const idx = getStackIdx(v);
      if (idx !== -1 && op !== 0x5f) {
        const freqDelta = firstPass ? 1 : 0;
        pushS(v, freqDelta);
        pushOp(0x80 + idx);
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
      const k = Number(stack.pop()!);
      pushS(mem.has(k) ? mem.get(k)! : 0n, 0);
    }
    if (op === 0x52) {
      // MSTORE
      const [offset, value] = pop2();
      const k = Number(offset);
      mem.set(k, value & MAX_256_BIT);
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

  const pushCost = (v: bigint): number => (v === 0n ? 1 : 1 + bytesLen(v));

  const pushN = (value: number | bigint) => {
    const v = typeof value === 'bigint' ? value : BigInt(value);
    if (v > 0n && v === BigInt(trackedMemSize)) return addOp(0x59);
    if (v === 32n) return addOp(0x36);
    if (v === 0n) return addOp(0x5f);

    let tmp = v;
    const bytes: number[] = [];
    while (tmp !== 0n) {
      bytes.unshift(Number(tmp & 0xffn));
      tmp >>= 8n;
    }
    return addOp(0x5f + bytes.length, bytes);
  };

  const pushB = (buf: Uint8Array) => addOp(0x5f + buf.length, Array.from(buf));

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
    for (const { s, e } of seg) {
      cost += 1 + (e - s + 1); // PUSH<n> immediate bytes
      if (31 - e > 0) cost += 1 + 1 + 1; // PUSH1 shift + SHL
      if (!first) cost += 1; // OR
      first = false;
    }
    return cost;
  };

  const emitBestValueForWord = (word: Uint8Array, seg: MemorySegment[]) => {
    const literal = word.slice(seg[0].s);
    let literalVal = 0n;
    for (const b of literal) literalVal = (literalVal << 8n) | BigInt(b);
    const literalCost = 1 + literal.length;
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
    const subCost = 1 + pushCost(subVal) + 1;
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
        const signCost = pushCost(truncated) + 2 + 1; // PUSH + PUSH1 + SIGNEXTEND
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

    const wordHex = _uint8ArrayToHex(word);
    // Encode Run?
    let runLen = 1;
    while (wordIndex + runLen < wordCount) {
      const w2 = view.getWord(wordIndex + runLen);
      const s2 = view.getSegments(wordIndex + runLen);
      if (!s2.length) break;
      if (_uint8ArrayToHex(w2) !== wordHex) break;
      ++runLen;
    }

    if (runLen >= 2) {
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
      if (stats && stats.lastWordIndex <= wordIndex + runLen - 1) {
        emitOp(0x50); // POP
      }
      wordIndex += runLen;
      continue;
    }

    const { literalCost, shlCost, bestCost, bestEmit } = emitBestValueForWord(word, seg);
    // Try MLOAD/MSTORE reuse
    if (literalCost > 8) {
      const stats = view.wordStats.get(wordHex);
      if (stats && stats.reuseCost !== -1 && wordIndex > stats.firstWordIndex) {
        const baseBytes =
          stats.firstOffset === 0 ? 0 : Math.ceil(Math.log2(stats.firstOffset + 1) / 8);
        if (literalCost > stats.reuseCost + baseBytes) {
          emitPushN(stats.firstOffset);
          emitOp(0x51); // MLOAD
          emitPushN(base);
          emitOp(0x52); // MSTORE
          ++wordIndex;
          continue;
        }
      }
    }
    const byte8s = seg.every(({ s, e }) => s === e);
    const byte8sCost = seg.length * 3; // PUSH1(value), PUSH1(offset), MSTORE8
    if (byte8s && byte8sCost < bestCost && byte8sCost <= shlCost) {
      for (const { s } of seg) {
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
  const planOut = plan.slice();
  ops = [];
  data = [];
  stack = [];
  trackedMemSize = 0;
  mem = new Map();
  firstPass = false;

  const reserved = new Set<bigint>([0n, 32n, selfbalance, decAddr, fromAddr]);
  Array.from(stackFreq.entries())
    .filter(([val, uses]) => uses > 1 && !reserved.has(val))
    .map(([val, uses]) => {
      const p = pushCost(val);
      const net = uses * (p - 1) - p;
      return { val, uses, net, p };
    })
    .sort((a, b) => {
      if (b.net !== a.net) return b.net - a.net;
      if (b.uses !== a.uses) return b.uses - a.uses;
      return a.p - b.p;
    })
    .filter((x) => x.net > 0 && x.val <= MAX_128_BIT)
    .slice(0, 15)
    .forEach(({ val }) => {
      pushN(val);
    });

  for (const step of planOut) {
    if (step.t === 'num') pushN(step.v);
    else if (step.t === 'bytes') pushB(step.b);
    else if (step.t === 'op') op(step.o);
  }

  // CALL stack layout (top to bottom): gas, address, value, argsOffset, argsSize, retOffset, retSize
  //
  // - 0x5f5f: PUSH0 PUSH0 (retSize=0, retOffset=0)
  // - pushN(view.dataLength): argsSize
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
  pushN(view.dataLength); // argsSize = actual data length
  pushN(padding); // argsOffset = padding

  const out: number[] = [];
  for (let i = 0; i < ops.length; ++i) {
    out.push(ops[i]);
    if (ops[i] >= 0x60 && ops[i] <= 0x7f && data[i]) out.push(...data[i]!);
  }

  // - CALLVALUE, load target address from calldata[0], GAS, CALL
  // - RETURNDATACOPY(0, 0, RETURNDATASIZE)
  // - RETURN(0, RETURNDATASIZE)
  const bytecode = '0x' + _uint8ArrayToHex(new Uint8Array(out)) + '345f355af13d5f5f3e3d5ff3';
  const calldataOut = '0x' + _normHex(originalTo).padStart(64, '0');

  return {
    bytecode,
    calldata: calldataOut,
    to: '0x' + decAddr.toString(16).padStart(40, '0'),
    from: _normHex(fromAddr.toString(16)).padStart(40, '0'),
    balance: selfbalance.toString(16),
  };
};
