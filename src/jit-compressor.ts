import { LibZip } from 'solady';
import { _jitDecompressor, DEC_ADDR } from './compiler';
import { _normHex } from './compiler/utils';
import { flzFwdBytecode, rleFwdBytecode } from './contracts';
import { MIN_BODY_SIZE } from './index';
/**
 * Compresses eth_call payload using JIT, FastLZ (FLZ), or calldata RLE (CD) compression.
 * Auto-selects best algorithm if not specified. Only compresses if >800 bytes and beneficial.
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
export const compress_call = function (payload: any, alg?: string): any {
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

  let bytecode: string;
  let calldata: string;
  let decompressorAddress: string;
  let fromAddr: string | undefined;
  let balanceHex: string;

  if (alg === 'jit' || (!alg && (originalSize < 3000 || originalSize >= 8000))) {
    const result = _jitDecompressor(inputData, to, from);
    bytecode = result.bytecode;
    calldata = result.calldata;
    decompressorAddress = result.to;
    fromAddr = result.from;
    balanceHex = result.balance;
  } else {
    const jit = !alg ? _jitDecompressor(inputData, to, from) : null;
    const flzData = alg === 'flz' || !alg ? LibZip.flzCompress(inputData) : null;
    const cdData = alg === 'cd' || (!alg && flzData) ? LibZip.cdCompress(inputData) : null;
    const useFlz =
      alg === 'flz' || (!alg && flzData && (!cdData || flzData.length < cdData.length));

    if (useFlz) {
      calldata = flzData!;
      bytecode = flzFwdBytecode(to);
    } else {
      calldata = cdData!;
      bytecode = rleFwdBytecode(to);
    }

    decompressorAddress = DEC_ADDR;
    fromAddr = from ? _normHex(from).padStart(16, '0') : undefined;
    balanceHex = '0';
    if (
      !alg &&
      jit &&
      jit.bytecode.length + jit.calldata.length < bytecode.length + calldata.length
    ) {
      bytecode = jit.bytecode;
      calldata = jit.calldata;
      decompressorAddress = jit.to;
      fromAddr = jit.from;
      balanceHex = jit.balance;
    }
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
