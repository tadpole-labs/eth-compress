import { MAX_256_BIT } from './constants';

export const not = (a: bigint): bigint => ~a & MAX_256_BIT;
export const eq = (a: bigint, b: bigint): bigint => (a === b ? 1n : 0n);
export const and = (a: bigint, b: bigint): bigint => a & b & MAX_256_BIT;
export const or = (a: bigint, b: bigint): bigint => (a | b) & MAX_256_BIT;
export const xor = (a: bigint, b: bigint): bigint => (a ^ b) & MAX_256_BIT;

export const add = (a: bigint, b: bigint): bigint => (a + b) & MAX_256_BIT;
export const sub = (a: bigint, b: bigint): bigint => (a - b) & MAX_256_BIT;

export const shl = (shift: bigint, value: bigint): bigint => (value << shift) & MAX_256_BIT;
export const shr = (shift: bigint, value: bigint): bigint => (value >> shift) & MAX_256_BIT;

export const sigext = (byteSize: bigint, value: bigint): bigint => {
  if (byteSize >= 31n) return value & MAX_256_BIT;
  const bits = Number((byteSize + 1n) * 8n);
  return BigInt.asUintN(256, BigInt.asIntN(bits, value));
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
