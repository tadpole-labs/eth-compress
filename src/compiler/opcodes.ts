import { MAX_256_BIT } from './constants';

export const not = (a: bigint): bigint => ~a & MAX_256_BIT;
export const eq = (a: bigint, b: bigint): bigint => a === b ? 1n : 0n;
export const and = (a: bigint, b: bigint): bigint => a & b & MAX_256_BIT;
export const or = (a: bigint, b: bigint): bigint => (a | b) & MAX_256_BIT;
export const xor = (a: bigint, b: bigint): bigint => (a ^ b) & MAX_256_BIT;
export const shl = (shift: bigint, value: bigint): bigint => (value << shift) & MAX_256_BIT;
export const shr = (shift: bigint, value: bigint): bigint => (value >> shift) & MAX_256_BIT;
export const sub = (a: bigint, b: bigint): bigint => (a - b) & MAX_256_BIT;
export const sigext = (byteSize: bigint, value: bigint): bigint => {
  const numBytes = Number(byteSize) + 1;
  const mask = (1n << BigInt(numBytes * 8)) - 1n;
  const signBit = 1n << BigInt(numBytes * 8 - 1);
  const maskedVal = value & mask;
  const extended = maskedVal & signBit ? maskedVal | (~mask & MAX_256_BIT) : maskedVal;
  return extended & MAX_256_BIT;
};

export const clz = (value: bigint): bigint => {
  if (value === 0n) return 256n;
  let count = 0n;
  let mask = 1n << 255n;
  while ((value & mask) === 0n && count < 256n) {
    count++;
    mask >>= 1n;
  }
  return count;
};

export const ctz = (value: bigint): bigint => {
  if (value === 0n) return 256n;
  let count = 0n;
  while (count < 256n && (value & (1n << count)) === 0n) {
    count++;
  }
  return count;
};