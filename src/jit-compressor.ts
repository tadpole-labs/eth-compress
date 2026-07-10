import { cdCompress, flzCompress } from './compression.ts';
import { flzFwdBytecode, rleFwdBytecode } from './contracts.ts';
import { MIN_BODY_SIZE } from './index.ts';
import { _jitDecompressor, DEC_ADDR, type ForwardMode } from './jit.ts';
import { _normHex } from './utils.ts';

/**
 * Compresses eth_call payload using JIT, FastLZ (FLZ), or calldata RLE (CD) compression.
 * Auto-selects best algorithm if not specified. Only compresses inputs ≥ MIN_BODY_SIZE and when beneficial.
 *
 * Only applies compression to calls that:
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
export const compress_call = function (
  payload: any,
  alg?: string,
  forward: ForwardMode = 'call',
  revert = false,
  clean_env = false,
): any {
  const { method, params } = payload;
  if (method && method !== 'eth_call') return payload;
  const txObj = params?.[0] || payload;
  const blockParam = params?.[1];
  const overrides = params?.[2];

  // Validation
  if (
    !txObj?.to ||
    !txObj?.data ||
    (() => {
      if (overrides) for (const _ in overrides) return true;
      for (const k in txObj) if (k !== 'to' && k !== 'data' && k !== 'from') return true;
      return false;
    })()
  ) {
    return payload;
  }

  const originalSize = txObj.data.length;
  if (originalSize < MIN_BODY_SIZE) return payload;

  const inputData = txObj.data;
  const to = txObj.to;
  const from = txObj.from;
  const noForward = forward === 'none';

  let bytecode: string;
  let calldata: string;
  let decompressorAddress: string;
  let fromAddr: string | undefined;
  let balanceHex: string;

  // Auto (no alg) compares JIT/FLZ/CD and keeps the smallest for every size; only an
  // explicit alg or forward:'none' (return mode, JIT-only) skips the comparison.
  if (noForward || alg === 'jit') {
    const result = _jitDecompressor(inputData, to, from, forward, revert, clean_env);
    bytecode = result.bytecode;
    calldata = result.calldata;
    decompressorAddress = result.to;
    fromAddr = result.from;
    balanceHex = result.balance;
  } else {
    const fwdFrom = from ? _normHex(from).padStart(16, '0') : undefined;
    const candidates: ReturnType<typeof _jitDecompressor>[] = [];

    if (alg === 'flz' || !alg) {
      candidates.push({
        bytecode: flzFwdBytecode(to, forward, revert),
        calldata: flzCompress(inputData),
        to: DEC_ADDR,
        from: fwdFrom,
        balance: '0',
      });
    }
    if (alg === 'cd' || !alg) {
      // cdCompress (Solady port) negates the first 4 bytes (selector-dispatch guard); XOR them back.
      const h = cdCompress(inputData).replace(/^0x/, '');
      let sel = '';
      for (let i = 0; i < 8; i += 2)
        sel += (Number.parseInt(h.substring(i, i + 2), 16) ^ 0xff).toString(16).padStart(2, '0');
      candidates.push({
        bytecode: rleFwdBytecode(to, forward, revert),
        calldata: '0x' + sel + h.substring(8),
        to: DEC_ADDR,
        from: fwdFrom,
        balance: '0',
      });
    }
    if (!alg) candidates.push(_jitDecompressor(inputData, to, from, forward, revert, clean_env));

    const best = candidates.reduce((a, b) =>
      b.bytecode.length + b.calldata.length < a.bytecode.length + a.calldata.length ? b : a,
    );
    bytecode = best.bytecode;
    calldata = best.calldata;
    decompressorAddress = best.to;
    fromAddr = best.from;
    balanceHex = best.balance;
  }

  // Skip if not beneficial
  if (bytecode.length + calldata.length >= originalSize) return payload;

  const stateOverride: any = {
    code: bytecode,
    balance: '0x' + balanceHex,
  };

  const compressedTxObj: any = { to: decompressorAddress, data: calldata };

  if (fromAddr) compressedTxObj.from = '0x' + fromAddr;

  return {
    ...payload,
    params: [compressedTxObj, blockParam, { ...overrides, [decompressorAddress]: stateOverride }],
  };
};
