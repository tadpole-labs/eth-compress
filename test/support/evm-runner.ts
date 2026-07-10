import { keccak256 } from 'viem';

type HexString = `0x${string}`;
type Quantity = bigint | number | string;

interface AccountOverride {
  balance?: Quantity;
  code?: string;
  storage?: Record<string, Quantity>;
}

interface RunEvmOptions {
  allowRevert?: boolean;
  callerAddress?: string;
  contractAddress?: string;
  gasLimit?: Quantity;
  state?: Record<string, AccountOverride>;
  value?: Quantity;
  verbose?: boolean;
}

interface EvmRunResult {
  gasUsed: bigint;
  returnValue: HexString;
  reverted?: boolean;
}

interface Account {
  balance: bigint;
  code: Uint8Array;
  storage: Map<string, bigint>;
}

interface Halt {
  kind: 'return' | 'revert' | 'stop';
  returnData: Uint8Array;
}

interface Frame {
  address: string;
  caller: string;
  callvalue: bigint;
  calldata: Uint8Array;
  code: Uint8Array;
  depth: number;
  isStatic: boolean;
  memory: Uint8Array;
  memorySize: number;
  origin: string;
  pc: number;
  returnData: Uint8Array;
  stack: bigint[];
}

const DEFAULT_GAS_LIMIT = 30_000_000n;
const MAX_DEPTH = 1024;
const MAX_MEMORY = 64 * 1024 * 1024;
const MAX_STACK = 1024;
const U160_MASK = (1n << 160n) - 1n;
const U256_MOD = 1n << 256n;
const U256_MASK = U256_MOD - 1n;
const U256_SIGN_BIT = 1n << 255n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const COINBASE = '0x4200000000000000000000000000000000000011';
const EMPTY_CODE_HASH = BigInt(keccak256(new Uint8Array()) as HexString);
const COLD_ACCOUNT_ACCESS = 2600n; // EIP-2929
const COLD_SLOAD = 2100n;
const WARM_ACCESS = 100n;

class EvmFault extends Error {
  readonly opcode: number;
  readonly frame?: Frame;

  constructor(message: string, opcode: number, frame?: Frame) {
    super(message);
    this.opcode = opcode;
    this.frame = frame;
  }
}

// Pure stack opcodes as [gas, fn]; operands are passed top-of-stack first, result is wrapped to u256.
const UNARY: Record<number, [bigint, (a: bigint) => bigint]> = {
  0x15: [3n, (v) => (v === 0n ? 1n : 0n)], // ISZERO
  0x19: [3n, (v) => ~v], // NOT
  0x1e: [5n, countLeadingZeros], // CLZ
  0x40: [20n, () => 0n], // BLOCKHASH (unsupported → 0)
  0x49: [3n, () => 0n], // BLOBHASH (unsupported → 0)
};

const BINARY: Record<number, [bigint, (a: bigint, b: bigint) => bigint]> = {
  0x01: [3n, (a, b) => a + b], // ADD
  0x02: [5n, (a, b) => a * b], // MUL
  0x03: [3n, (a, b) => a - b], // SUB
  0x04: [5n, (a, b) => (b === 0n ? 0n : a / b)], // DIV
  0x05: [5n, signedDiv], // SDIV
  0x06: [5n, (a, b) => (b === 0n ? 0n : a % b)], // MOD
  0x07: [5n, signedMod], // SMOD
  0x0b: [5n, signExtend], // SIGNEXTEND
  0x10: [3n, (a, b) => (a < b ? 1n : 0n)], // LT
  0x11: [3n, (a, b) => (a > b ? 1n : 0n)], // GT
  0x12: [3n, (a, b) => (toSigned(a) < toSigned(b) ? 1n : 0n)], // SLT
  0x13: [3n, (a, b) => (toSigned(a) > toSigned(b) ? 1n : 0n)], // SGT
  0x14: [3n, (a, b) => (a === b ? 1n : 0n)], // EQ
  0x16: [3n, (a, b) => a & b], // AND
  0x17: [3n, (a, b) => a | b], // OR
  0x18: [3n, (a, b) => a ^ b], // XOR
  0x1a: [3n, evmByte], // BYTE
  0x1b: [3n, (shift, value) => (shift >= 256n ? 0n : value << shift)], // SHL
  0x1c: [3n, (shift, value) => (shift >= 256n ? 0n : value >> shift)], // SHR
  0x1d: [3n, (shift, value) => arithmeticShiftRight(value, shift)], // SAR
};

const TERNARY: Record<number, [bigint, (a: bigint, b: bigint, c: bigint) => bigint]> = {
  0x08: [8n, (a, b, n) => (n === 0n ? 0n : (a + b) % n)], // ADDMOD
  0x09: [8n, (a, b, n) => (n === 0n ? 0n : (a * b) % n)], // MULMOD
};

// Environment opcodes: 2 gas, no operands, push a value derived from the frame/VM.
const CONST: Record<number, (frame: Frame, vm: TestEvm) => bigint> = {
  0x30: (f) => wordFromAddress(f.address), // ADDRESS
  0x32: (f) => wordFromAddress(f.origin), // ORIGIN
  0x33: (f) => wordFromAddress(f.caller), // CALLER
  0x34: (f) => f.callvalue, // CALLVALUE
  0x36: (f) => BigInt(f.calldata.length), // CALLDATASIZE
  0x38: (f) => BigInt(f.code.length), // CODESIZE
  0x3a: () => 0n, // GASPRICE
  0x3d: (f) => BigInt(f.returnData.length), // RETURNDATASIZE
  0x41: () => wordFromAddress(COINBASE), // COINBASE
  0x42: () => 1_700_000_000n, // TIMESTAMP
  0x43: () => 0n, // NUMBER
  0x44: () => 0n, // PREVRANDAO
  0x45: (_f, vm) => vm.gasLimit, // GASLIMIT
  0x46: () => 8453n, // CHAINID
  0x48: () => 1n, // BASEFEE
  0x4a: () => 1n, // BLOBBASEFEE
  0x58: (f) => BigInt(f.pc), // PC
  0x59: (f) => BigInt(roundUp32(f.memorySize)), // MSIZE
  0x5a: (_f, vm) => vm.gasLimit - vm.gasUsed, // GAS
  0x5f: () => 0n, // PUSH0
};

class TestEvm {
  readonly accounts = new Map<string, Account>();
  readonly transientStorage = new Map<string, bigint>();
  readonly warmAddresses = new Set<string>(); // EIP-2929 access sets (per execution)
  readonly warmSlots = new Set<string>();
  readonly gasLimit: bigint;
  gasUsed = 0n;

  constructor(options: RunEvmOptions) {
    this.gasLimit = parseQuantity(options.gasLimit, DEFAULT_GAS_LIMIT);
    for (const [address, account] of Object.entries(options.state ?? {})) {
      this.putAccount(normalizeAddress(address), account);
    }
  }

  putAccount(address: string, override: AccountOverride) {
    const account = this.getOrCreateAccount(normalizeAddress(address));
    if (override.balance !== undefined) account.balance = parseQuantity(override.balance, 0n);
    if (override.code !== undefined) account.code = hexToBytes(override.code);
    for (const [key, value] of Object.entries(override.storage ?? {})) {
      account.storage.set(storageKey(parseQuantity(key, 0n)), toU256(parseQuantity(value, 0n)));
    }
  }

  // EIP-2929 warm/cold access cost, marking the address/slot warm for subsequent touches.
  private accessAddress(address: string): bigint {
    if (this.warmAddresses.has(address)) return WARM_ACCESS;
    this.warmAddresses.add(address);
    return COLD_ACCOUNT_ACCESS;
  }

  private accessSlot(address: string, key: string): bigint {
    const id = `${address}:${key}`;
    if (this.warmSlots.has(id)) return WARM_ACCESS;
    this.warmSlots.add(id);
    return COLD_SLOAD;
  }

  runCode(params: {
    address: string;
    calldata: Uint8Array;
    caller: string;
    code: Uint8Array;
    origin: string;
    value: bigint;
  }): Halt {
    // EIP-2929 / EIP-3651: tx origin + target + coinbase + precompiles begin warm.
    for (const a of [params.origin, params.address, COINBASE]) {
      this.warmAddresses.add(normalizeAddress(a));
    }
    for (let i = 1; i <= 10; i++) this.warmAddresses.add(normalizeAddress(`0x${i.toString(16)}`));
    return this.executeFrame(
      this.createFrame({
        ...params,
        address: normalizeAddress(params.address),
        caller: normalizeAddress(params.caller),
        origin: normalizeAddress(params.origin),
        depth: 0,
        isStatic: false,
      }),
    );
  }

  private createFrame(params: {
    address: string;
    calldata: Uint8Array;
    caller: string;
    code: Uint8Array;
    depth: number;
    isStatic: boolean;
    origin: string;
    value: bigint;
  }): Frame {
    return {
      address: params.address,
      caller: params.caller,
      callvalue: toU256(params.value),
      calldata: params.calldata,
      code: params.code,
      depth: params.depth,
      isStatic: params.isStatic,
      memory: new Uint8Array(0),
      memorySize: 0,
      origin: params.origin,
      pc: 0,
      returnData: new Uint8Array(0),
      stack: [],
    };
  }

  private executeFrame(frame: Frame): Halt {
    const jumpdests = scanJumpdests(frame.code);

    while (frame.pc < frame.code.length) {
      const op = frame.code[frame.pc];
      try {
        const binary = BINARY[op];
        const unary = UNARY[op];
        const ternary = TERNARY[op];
        const konst = CONST[op];
        if (binary) {
          this.charge(binary[0]);
          this.push(frame, binary[1](this.pop(frame), this.pop(frame)));
        } else if (unary) {
          this.charge(unary[0]);
          this.push(frame, unary[1](this.pop(frame)));
        } else if (ternary) {
          this.charge(ternary[0]);
          this.push(frame, ternary[1](this.pop(frame), this.pop(frame), this.pop(frame)));
        } else if (konst) {
          this.charge(2n);
          this.push(frame, konst(frame, this));
        } else {
          switch (op) {
            case 0x00:
              return { kind: 'stop', returnData: new Uint8Array(0) };
            case 0x0a: {
              const base = this.pop(frame);
              const exp = this.pop(frame);
              this.charge(10n + 50n * BigInt(byteLength(exp)));
              this.push(frame, powMod256(base, exp));
              break;
            }
            case 0x20: {
              this.charge(30n);
              const offset = this.toMemNum(frame, this.pop(frame));
              const size = this.toMemNum(frame, this.pop(frame));
              this.charge(6n * wordsFor(size));
              this.push(
                frame,
                BigInt(keccak256(this.readMemory(frame, offset, size)) as HexString),
              );
              break;
            }
            case 0x31: {
              const address = addressFromWord(this.pop(frame));
              this.charge(this.accessAddress(address));
              this.push(frame, this.accounts.get(address)?.balance ?? 0n);
              break;
            }
            case 0x35: {
              this.charge(3n);
              this.push(
                frame,
                wordFromBytes(frame.calldata, this.toDataIndex(this.pop(frame)), 32),
              );
              break;
            }
            case 0x37: {
              this.charge(3n);
              const dst = this.toMemNum(frame, this.pop(frame));
              const src = this.toDataIndex(this.pop(frame));
              const size = this.toMemNum(frame, this.pop(frame));
              this.charge(3n * wordsFor(size));
              this.copyToMemory(frame, dst, frame.calldata, src, size);
              break;
            }
            case 0x39: {
              this.charge(3n);
              const dst = this.toMemNum(frame, this.pop(frame));
              const src = this.toDataIndex(this.pop(frame));
              const size = this.toMemNum(frame, this.pop(frame));
              this.charge(3n * wordsFor(size));
              this.copyToMemory(frame, dst, frame.code, src, size);
              break;
            }
            case 0x3b: {
              const address = addressFromWord(this.pop(frame));
              this.charge(this.accessAddress(address));
              this.push(frame, BigInt(this.accounts.get(address)?.code.length ?? 0));
              break;
            }
            case 0x3c: {
              const address = addressFromWord(this.pop(frame));
              this.charge(this.accessAddress(address));
              const dst = this.toMemNum(frame, this.pop(frame));
              const src = this.toDataIndex(this.pop(frame));
              const size = this.toMemNum(frame, this.pop(frame));
              this.charge(3n * wordsFor(size));
              this.copyToMemory(
                frame,
                dst,
                this.accounts.get(address)?.code ?? new Uint8Array(0),
                src,
                size,
              );
              break;
            }
            case 0x3e: {
              this.charge(3n);
              const dst = this.toMemNum(frame, this.pop(frame));
              const src = this.toDataIndex(this.pop(frame));
              const size = this.toMemNum(frame, this.pop(frame));
              if (src + size > frame.returnData.length)
                throw this.fault(frame, op, 'RETURNDATACOPY out of bounds');
              this.charge(3n * wordsFor(size));
              this.copyToMemory(frame, dst, frame.returnData, src, size);
              break;
            }
            case 0x3f: {
              const address = addressFromWord(this.pop(frame));
              this.charge(this.accessAddress(address));
              const account = this.accounts.get(address);
              if (!account) this.push(frame, 0n);
              else if (account.code.length === 0) this.push(frame, EMPTY_CODE_HASH);
              else this.push(frame, BigInt(keccak256(account.code) as HexString));
              break;
            }
            case 0x47: {
              this.charge(5n);
              this.push(frame, this.accounts.get(frame.address)?.balance ?? 0n);
              break;
            }
            case 0x50:
              this.charge(2n);
              this.pop(frame);
              break;
            case 0x51: {
              this.charge(3n);
              const offset = this.toMemNum(frame, this.pop(frame));
              this.push(frame, wordFromBytes(this.readMemory(frame, offset, 32), 0, 32));
              break;
            }
            case 0x52: {
              this.charge(3n);
              const offset = this.toMemNum(frame, this.pop(frame));
              this.writeMemory(frame, offset, wordToBytes(this.pop(frame)));
              break;
            }
            case 0x53: {
              this.charge(3n);
              const offset = this.toMemNum(frame, this.pop(frame));
              this.writeMemory(frame, offset, new Uint8Array([Number(this.pop(frame) & 0xffn)]));
              break;
            }
            case 0x54: {
              const key = storageKey(this.pop(frame));
              this.charge(this.accessSlot(frame.address, key));
              this.push(frame, this.getOrCreateAccount(frame.address).storage.get(key) ?? 0n);
              break;
            }
            case 0x55: {
              if (frame.isStatic) throw this.fault(frame, op, 'SSTORE in static context');
              this.charge(2900n);
              const key = storageKey(this.pop(frame));
              this.getOrCreateAccount(frame.address).storage.set(key, toU256(this.pop(frame)));
              break;
            }
            case 0x56:
              this.charge(8n);
              frame.pc = this.toJumpDest(frame, this.pop(frame), jumpdests);
              continue;
            case 0x57: {
              this.charge(10n);
              const destWord = this.pop(frame);
              if (this.pop(frame) !== 0n) {
                frame.pc = this.toJumpDest(frame, destWord, jumpdests);
                continue;
              }
              break;
            }
            case 0x5b:
              this.charge(1n);
              break;
            case 0x5c: {
              this.charge(100n);
              const key = storageKey(this.pop(frame));
              this.push(frame, this.transientStorage.get(transientKey(frame.address, key)) ?? 0n);
              break;
            }
            case 0x5d: {
              if (frame.isStatic) throw this.fault(frame, op, 'TSTORE in static context');
              this.charge(100n);
              const key = storageKey(this.pop(frame));
              this.transientStorage.set(transientKey(frame.address, key), toU256(this.pop(frame)));
              break;
            }
            case 0x5e: {
              const dst = this.toMemNum(frame, this.pop(frame));
              const src = this.toMemNum(frame, this.pop(frame));
              const size = this.toMemNum(frame, this.pop(frame));
              this.charge(3n + 3n * wordsFor(size));
              this.copyMemory(frame, dst, src, size);
              break;
            }
            case 0xf0:
            case 0xf5: {
              if (frame.isStatic)
                throw this.fault(
                  frame,
                  op,
                  `${op === 0xf5 ? 'CREATE2' : 'CREATE'} in static context`,
                );
              this.charge(32_000n);
              for (let i = op === 0xf5 ? 4 : 3; i > 0; i--) this.pop(frame);
              this.push(frame, 0n);
              break;
            }
            case 0xf1:
            case 0xf2:
            case 0xf4:
            case 0xfa:
              this.executeCall(frame, op);
              break;
            case 0xf3:
            case 0xfd: {
              const offset = this.toMemNum(frame, this.pop(frame));
              const size = this.toMemNum(frame, this.pop(frame));
              const returnData = this.readMemory(frame, offset, size);
              return { kind: op === 0xfd ? 'revert' : 'return', returnData };
            }
            case 0xfe:
              throw this.fault(frame, op, 'INVALID opcode');
            case 0xff:
              if (frame.isStatic) throw this.fault(frame, op, 'SELFDESTRUCT in static context');
              this.charge(5000n);
              this.pop(frame);
              return { kind: 'stop', returnData: new Uint8Array(0) };
            default:
              if (op >= 0x60 && op <= 0x7f) {
                this.charge(3n);
                const bytes = op - 0x5f;
                let value = 0n;
                for (let i = 1; i <= bytes; i++)
                  value = (value << 8n) | BigInt(frame.code[frame.pc + i] ?? 0);
                this.push(frame, value);
                frame.pc += 1 + bytes;
                continue;
              }
              if (op >= 0x80 && op <= 0x8f) {
                this.charge(3n);
                const depth = op - 0x7f;
                if (frame.stack.length < depth) throw this.fault(frame, op, 'stack underflow');
                this.push(frame, frame.stack[frame.stack.length - depth]);
                break;
              }
              if (op >= 0x90 && op <= 0x9f) {
                this.charge(3n);
                const depth = op - 0x8f;
                if (frame.stack.length <= depth) throw this.fault(frame, op, 'stack underflow');
                const top = frame.stack.length - 1;
                const other = top - depth;
                [frame.stack[top], frame.stack[other]] = [frame.stack[other], frame.stack[top]];
                break;
              }
              if (op >= 0xa0 && op <= 0xa4) {
                if (frame.isStatic) throw this.fault(frame, op, 'LOG in static context');
                const topics = op - 0xa0;
                const offset = this.toMemNum(frame, this.pop(frame));
                const size = this.toMemNum(frame, this.pop(frame));
                for (let i = 0; i < topics; i++) this.pop(frame);
                this.readMemory(frame, offset, size);
                this.charge(375n + 375n * BigInt(topics) + 8n * BigInt(size));
                break;
              }
              throw this.fault(
                frame,
                op,
                `unsupported opcode 0x${op.toString(16).padStart(2, '0')}`,
              );
          }
        }
      } catch (err) {
        if (err instanceof EvmFault) throw err;
        throw this.fault(frame, op, err instanceof Error ? err.message : String(err));
      }

      frame.pc++;
    }

    return { kind: 'stop', returnData: new Uint8Array(0) };
  }

  private executeCall(frame: Frame, opcode: number) {
    if (frame.depth + 1 >= MAX_DEPTH) throw this.fault(frame, opcode, 'call depth exceeded');

    const transfersValue = opcode === 0xf1 || opcode === 0xf2;
    const gas = this.pop(frame);
    const to = addressFromWord(this.pop(frame));
    const value = transfersValue ? this.pop(frame) : 0n;
    const argsOffset = this.toMemNum(frame, this.pop(frame));
    const argsLength = this.toMemNum(frame, this.pop(frame));
    const returnOffset = this.toMemNum(frame, this.pop(frame));
    const returnLength = this.toMemNum(frame, this.pop(frame));

    if (frame.isStatic && value !== 0n)
      throw this.fault(frame, opcode, 'value call in static context');

    // EIP-2929 cold/warm target access + positive-value cost (new-account cost not modeled).
    this.charge(this.accessAddress(to) + (value > 0n ? 9000n : 0n));

    const callData = this.readMemory(frame, argsOffset, argsLength);
    this.expandMemory(frame, returnOffset + returnLength);

    const precompile = this.runPrecompile(to, callData);
    if (precompile) {
      frame.returnData = precompile;
      this.copyReturnData(frame, returnOffset, returnLength, precompile);
      this.push(frame, 1n);
      return;
    }

    const targetCode = this.accounts.get(to)?.code ?? new Uint8Array(0);
    if (targetCode.length === 0) {
      frame.returnData = new Uint8Array(0);
      this.push(frame, 1n);
      return;
    }

    const child = this.createFrame({
      address: opcode === 0xf2 || opcode === 0xf4 ? frame.address : to,
      calldata: callData,
      caller: opcode === 0xf4 ? frame.caller : frame.address,
      code: targetCode,
      depth: frame.depth + 1,
      isStatic: frame.isStatic || opcode === 0xfa,
      origin: frame.origin,
      value: opcode === 0xf4 ? frame.callvalue : value,
    });

    const beforeGas = this.gasUsed;
    let success = false;
    let returnData: Uint8Array = new Uint8Array(0);
    try {
      const result = this.executeFrame(child);
      success = result.kind !== 'revert';
      returnData = result.returnData;
    } catch {
      success = false;
    }

    const requestedGas = toU256(gas);
    if (requestedGas > 0n && this.gasUsed - beforeGas > requestedGas) success = false;

    frame.returnData = returnData;
    this.copyReturnData(frame, returnOffset, returnLength, returnData);
    this.push(frame, success ? 1n : 0n);
  }

  private runPrecompile(address: string, calldata: Uint8Array): Uint8Array | undefined {
    const id = Number(BigInt(normalizeAddress(address)) & 0xffn);
    const isPrecompile =
      address.startsWith('0x000000000000000000000000000000000000000') && id >= 1 && id <= 10;
    if (!isPrecompile) return undefined;
    return id === 4 ? new Uint8Array(calldata) : new Uint8Array(0); // identity / stub
  }

  private copyReturnData(frame: Frame, offset: number, length: number, data: Uint8Array) {
    const copyLength = Math.min(length, data.length);
    if (copyLength > 0) this.writeMemory(frame, offset, data.subarray(0, copyLength));
  }

  private getOrCreateAccount(address: string): Account {
    let account = this.accounts.get(address);
    if (!account) {
      account = { balance: 0n, code: new Uint8Array(0), storage: new Map() };
      this.accounts.set(address, account);
    }
    return account;
  }

  private charge(amount: bigint) {
    if (amount < 0n) return;
    this.gasUsed += amount;
    if (this.gasUsed > this.gasLimit) throw new EvmFault('out of gas', 0);
  }

  private expandMemory(frame: Frame, end: number) {
    if (end <= frame.memorySize) return;
    if (end > MAX_MEMORY)
      throw this.fault(frame, frame.code[frame.pc] ?? 0, 'memory out of bounds');

    const oldWords = BigInt(Math.ceil(frame.memorySize / 32));
    const newWords = BigInt(Math.ceil(end / 32));
    const oldCost = 3n * oldWords + (oldWords * oldWords) / 512n;
    const newCost = 3n * newWords + (newWords * newWords) / 512n;
    this.charge(newCost - oldCost);

    if (end > frame.memory.length) {
      const next = new Uint8Array(Math.max(end, frame.memory.length * 2, 1024));
      next.set(frame.memory);
      frame.memory = next;
    }
    frame.memorySize = end;
  }

  private readMemory(frame: Frame, offset: number, length: number): Uint8Array {
    if (length === 0) return new Uint8Array(0);
    this.expandMemory(frame, offset + length);
    return frame.memory.slice(offset, offset + length);
  }

  private writeMemory(frame: Frame, offset: number, bytes: Uint8Array) {
    if (bytes.length === 0) return;
    this.expandMemory(frame, offset + bytes.length);
    frame.memory.set(bytes, offset);
  }

  private copyMemory(frame: Frame, dst: number, src: number, length: number) {
    if (length === 0) return;
    this.expandMemory(frame, Math.max(dst + length, src + length));
    frame.memory.copyWithin(dst, src, src + length);
  }

  private copyToMemory(
    frame: Frame,
    dst: number,
    source: Uint8Array,
    sourceOffset: number,
    length: number,
  ) {
    if (length === 0) return;
    this.expandMemory(frame, dst + length);
    const end = Math.min(source.length, sourceOffset + length);
    if (sourceOffset < source.length) frame.memory.set(source.subarray(sourceOffset, end), dst);
    const copied = Math.max(0, end - sourceOffset);
    if (copied < length) frame.memory.fill(0, dst + copied, dst + length);
  }

  private pop(frame: Frame): bigint {
    const value = frame.stack.pop();
    if (value === undefined) throw this.fault(frame, frame.code[frame.pc] ?? 0, 'stack underflow');
    return value;
  }

  private push(frame: Frame, value: bigint) {
    if (frame.stack.length >= MAX_STACK)
      throw this.fault(frame, frame.code[frame.pc] ?? 0, 'stack overflow');
    frame.stack.push(toU256(value));
  }

  private toDataIndex(value: bigint): number {
    return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
  }

  private toJumpDest(frame: Frame, value: bigint, jumpdests: Set<number>): number {
    const dest = this.toMemNum(frame, value);
    if (!jumpdests.has(dest)) throw this.fault(frame, frame.code[frame.pc] ?? 0, 'invalid jump');
    return dest;
  }

  private toMemNum(frame: Frame, value: bigint): number {
    if (value > BigInt(MAX_MEMORY))
      throw this.fault(frame, frame.code[frame.pc] ?? 0, 'memory access too large');
    return Number(value);
  }

  private fault(frame: Frame, opcode: number, message: string): EvmFault {
    return new EvmFault(message, opcode, frame);
  }
}

export async function runEvmBytecode(
  bytecode: string,
  calldata: string,
  options: RunEvmOptions = {},
): Promise<EvmRunResult | null> {
  const vm = new TestEvm(options);
  const code = hexToBytes(bytecode);
  const hasContract = options.contractAddress !== undefined;
  const address = hasContract ? normalizeAddress(options.contractAddress) : ZERO_ADDRESS;
  const caller = options.callerAddress ? normalizeAddress(options.callerAddress) : ZERO_ADDRESS;

  if (hasContract) vm.putAccount(address, { code: bytecode });

  try {
    const result = vm.runCode({
      address,
      calldata: hexToBytes(calldata),
      caller,
      code,
      origin: caller,
      value: parseQuantity(options.value, 0n),
    });

    if (result.kind === 'revert') {
      if (!options.allowRevert || result.returnData.length === 0) return null;
      return { gasUsed: vm.gasUsed, returnValue: bytesToHex(result.returnData), reverted: true };
    }

    if (result.returnData.length === 0) {
      if (options.verbose) console.error('Empty return value - execution may have stopped');
      return null;
    }

    return { gasUsed: vm.gasUsed, returnValue: bytesToHex(result.returnData) };
  } catch (err) {
    if (options.verbose) {
      console.error(err instanceof EvmFault ? formatFault(err) : `Execution error: ${err}`);
    }
    return null;
  }
}

function scanJumpdests(code: Uint8Array): Set<number> {
  const dests = new Set<number>();
  for (let pc = 0; pc < code.length; pc++) {
    const op = code[pc];
    if (op === 0x5b) dests.add(pc);
    else if (op >= 0x60 && op <= 0x7f) pc += op - 0x5f;
  }
  return dests;
}

function toU256(value: bigint): bigint {
  return value & U256_MASK;
}

function toSigned(value: bigint): bigint {
  const normalized = toU256(value);
  return normalized >= U256_SIGN_BIT ? normalized - U256_MOD : normalized;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function signedDiv(a: bigint, b: bigint): bigint {
  const dividend = toSigned(a);
  const divisor = toSigned(b);
  if (divisor === 0n) return 0n;
  const quotient = abs(dividend) / abs(divisor);
  return dividend < 0n !== divisor < 0n ? -quotient : quotient;
}

function signedMod(a: bigint, b: bigint): bigint {
  const dividend = toSigned(a);
  const divisor = toSigned(b);
  if (divisor === 0n) return 0n;
  const remainder = abs(dividend) % abs(divisor);
  return dividend < 0n ? -remainder : remainder;
}

function powMod256(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = toU256(base);
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = toU256(result * b);
    if (e > 1n) b = toU256(b * b);
  }
  return result;
}

function signExtend(k: bigint, value: bigint): bigint {
  if (k >= 32n) return value;
  const bit = 8n * k + 7n;
  const mask = (1n << (bit + 1n)) - 1n;
  return (value & (1n << bit)) !== 0n ? value | (U256_MASK ^ mask) : value & mask;
}

function evmByte(index: bigint, value: bigint): bigint {
  return index >= 32n ? 0n : (value >> ((31n - index) * 8n)) & 0xffn;
}

function arithmeticShiftRight(value: bigint, shift: bigint): bigint {
  if (shift >= 256n) return value >= U256_SIGN_BIT ? U256_MASK : 0n;
  return toU256(toSigned(value) >> shift);
}

function countLeadingZeros(value: bigint): bigint {
  return value === 0n ? 256n : 256n - BigInt(value.toString(2).length);
}

function byteLength(value: bigint): number {
  return value === 0n ? 0 : Math.ceil(value.toString(16).length / 2);
}

function wordsFor(length: number): bigint {
  return BigInt(Math.ceil(length / 32));
}

function roundUp32(value: number): number {
  return Math.ceil(value / 32) * 32;
}

function wordFromBytes(bytes: Uint8Array, offset: number, length: number): bigint {
  let value = 0n;
  for (let i = 0; i < length; i++) value = (value << 8n) | BigInt(bytes[offset + i] ?? 0);
  return value;
}

function wordToBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let current = toU256(value);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(current & 0xffn);
    current >>= 8n;
  }
  return out;
}

function wordFromAddress(address: string): bigint {
  return BigInt(normalizeAddress(address));
}

function addressFromWord(value: bigint): string {
  return `0x${(value & U160_MASK).toString(16).padStart(40, '0')}`;
}

function normalizeAddress(address?: string): string {
  if (!address) return ZERO_ADDRESS;
  return `0x${address.replace(/^0x/i, '').toLowerCase().padStart(40, '0').slice(-40)}`;
}

function hexToBytes(hex: string): Uint8Array {
  let clean = hex.replace(/^0x/i, '').toLowerCase();
  if (clean.length % 2 !== 0) clean = `0${clean}`;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): HexString {
  let out = '0x';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out as HexString;
}

function parseQuantity(value: Quantity | undefined, fallback: bigint): bigint {
  if (value === undefined || value === '') return fallback;
  return typeof value === 'bigint' ? value : BigInt(value);
}

function storageKey(value: bigint): string {
  return toU256(value).toString(16).padStart(64, '0');
}

function transientKey(address: string, key: string): string {
  return `${address}:${key}`;
}

function formatFault(err: EvmFault): string {
  const f = err.frame;
  const stack = f ? f.stack.map((v) => `0x${v.toString(16)}`) : [];
  const memory = f ? bytesToHex(f.memory.subarray(0, f.memorySize)) : '0x';
  return [
    '\n=== TEST EVM EXCEPTION ===',
    `  PC: ${f?.pc ?? '?'}`,
    `  Opcode: 0x${err.opcode.toString(16).padStart(2, '0')}`,
    `  Stack: ${JSON.stringify(stack)}`,
    `  Memory: ${memory}`,
    `  ${err.message}`,
    '==========================\n',
  ].join('\n');
}
