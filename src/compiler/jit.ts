import { MAX_128_BIT, MAX_256_BIT } from './constants';
import { and, clz, ctz, not, or, shl, shr, sigext, sub, xor } from './opcodes';
import { _normHex, _uint8ArrayToHex, initMemoryView } from './utils';

export const _jitDecompressor = function (
  calldata: string,
  to: string,
  from?: string,
): { bytecode: string; calldata: string; to: string; from?: string; balance: string } {
  // Right‑align the 4‑byte selector in the first 32‑byte slot (offset 28),
  // so that everything after the selector is reconstructed on mostly
  // word‑aligned boundaries. This keeps the ABI words (and therefore most
  // calldata reconstruction) 32‑byte aligned in memory.
  // That way we avoid encoding offsets for writes (most of the time),
  const padding = 28;
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
  const getStackIdx = (val: bigint): number => {
    let idx = stack.lastIndexOf(val);
    idx = idx === -1 ? -1 : stack.length - 1 - idx;
    return idx > 15 ? -1 : idx;
  };

  const opFreq = new Map<number, number>();
  const dataFreq = new Map<number[] | null, number>();
  const stackFreq = new Map<bigint, number>();
  const roundUp32 = (x: number) => (x + 31) & ~31;

  let pushCounter = 0;
  const stackCnt = new Map<bigint, number>();
  const pop2 = (): [bigint, bigint] => [stack.pop()!, stack.pop()!];
  const ctr = <K>(m: Map<K, number>, k: K, delta: number) => m.set(k, (m.get(k) || 0) + delta);
  const inc = <K>(m: Map<K, number>, k: K) => ctr(m, k, 1);
  const pushOp = (op: number, d?: number[] | null) => {
    ops.push(op);
    inc(opFreq, op);
    const imm = d ?? null;
    data.push(imm);
    inc(dataFreq, imm);
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
    if (op === 0x80) {
      // DUP1
      const val = stack.pop();
      stack.push(val);
      pushS(val, firstPass ? 0 : 1);
    } else if (op === 0x47) {
      pushS(selfbalance, 0);
    } else if (op === 0x30) {
      pushS(decAddr, 0);
    } else if (op === 0x33) {
      pushS(fromAddr, 0);
    } else if (op === 0x36) {
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
      if (v == selfbalance) {
        pushS(v, 0);
        pushOp(0x47); // SELFBALANCE
        return;
      }
      if (v == decAddr) {
        pushS(v, 0);
        pushOp(0x30); // ADDRESS (SELF)
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
      if (v === BigInt(trackedMemSize)) {
        pushS(v, 0);
        pushOp(0x59); // MSIZE
        return;
      }
      const idx = getStackIdx(v);
      if (idx !== -1 && op != 0x5f) {
        let pushCtr = firstPass ? 1 : -1;
        pushS(v, pushCtr);
        pushOp(128 + idx);
        return;
      }
      if (v == MAX_256_BIT) {
        pushS(v);
        pushOp(0x5f); // 0
        pushOp(0x19); // NOT
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
      mem.set(k, value & MAX_256_BIT);
      trackMem(k, 32);
    } else if (op === 0x53) {
      // MSTORE8
      const [offset, _] = pop2();
      trackMem(Number(offset), 1);
    } else if (op === 0xf3) {
      // RETURN
      pop2();
    }
    pushOp(op, imm || null);
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
  let _stack = [selfbalance, 32n, decAddr, fromAddr];
  for (let wordIndex = 0; wordIndex < wordCount; ++wordIndex) {
    const base = wordIndex * 32;
    const word = view.getWord(wordIndex);
    const seg = view.getSegments(wordIndex);

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
      const stats = view.wordStats.get(wordHex);
      if (stats && stats.reuseCost !== -1 && wordIndex > stats.firstWordIndex) {
        if (literalCost > stats.reuseCost + baseBytes) {
          emitPushN(stats.firstOffset);
          emitOp(0x51); // MLOAD
          emitPushN(base);
          emitOp(0x52); // MSTORE
          continue;
        }
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
        ++notBytes;
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
        ++subBytes;
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
            ++shiftedBytes;
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
    .filter(
      ([val, freq]) =>
        freq > 1 &&
        val > 0n &&
        val != selfbalance &&
        val !== 32n &&
        val !== decAddr &&
        val != fromAddr,
    )
    .sort((a, b) => stackCnt.get(b[0])! - stackCnt.get(a[0])!)
    .filter(([val, _]) => {
      return typeof val === 'number' ? BigInt(val) : val <= MAX_128_BIT;
    })
    .slice(0, 15)
    .forEach(([val, _]) => {
      pushN(val);
    });
  // Second pass: emit ops and track mem/stack
  for (const step of plan) {
    if (step.t === 'num') pushN(step.v);
    else if (step.t === 'bytes') pushB(step.b);
    else if (step.t === 'op') op(step.o);
  }

  // CALL stack layout (top to bottom): gas, address, value, argsOffset, argsSize, retOffset, retSize
  //
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
