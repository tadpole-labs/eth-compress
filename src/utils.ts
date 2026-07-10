export const MAX_128_BIT = (1n << 128n) - 1n;
export const MAX_256_BIT = (1n << 256n) - 1n;

export const _normHex = (hex: string): string =>
  (hex.charCodeAt(0) === 48 && (hex.charCodeAt(1) | 32) === 120 ? hex.slice(2) : hex).toLowerCase();

const _hexes = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0')),
  _nibbles = (() => {
    const t = new Int8Array(103).fill(-1);
    for (let i = 0; i < 10; i++) t[48 + i] = i;
    for (let i = 0; i < 6; i++) t[97 + i] = 10 + i;
    return t;
  })();

export const _hexToUint8Array = (hex: string): Uint8Array => {
  const normalized = _normHex(hex);
  const len = normalized.length;
  const bytes = new Uint8Array(len / 2);
  for (let i = 0, j = 0; i < len; i += 2) {
    bytes[j++] = (_nibbles[normalized.charCodeAt(i)] << 4) | _nibbles[normalized.charCodeAt(i + 1)];
  }
  return bytes;
};

export const _uint8ArrayToHex = (bytes: Uint8Array): string => {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += _hexes[bytes[i]]!;
  return hex;
};

export type MemorySegment = number; // (s << 8) | e, both in [0..31]
const _zeroWord = new Uint8Array(32);
const _emptySegments: MemorySegment[] = [];

export type WordStats = [
  freq: number,
  normFreq: number,
  firstWordIndex: number,
  lastWordIndex: number,
  firstOffset: number,
  lastOffset: number,
  reuseCost: number,
];

export interface MemoryView {
  /** Normalized hex string (without 0x) of the original payload. */
  readonly hex: string;
  /** Backing buffer containing `padding` zero bytes followed by the payload. */
  readonly buffer: Uint8Array;
  /** Total length of the backing buffer (padding + payload length), rounded up to full words. */
  readonly roundedLength: number;
  /** Number of zero bytes prefixed before the payload. */
  readonly padding: number;
  /** Length of the original (unpadded) payload in bytes. */
  readonly dataLength: number;
  /** Number of 32-byte words in this view. */
  readonly wordCount: number;
  /** Hex string (without 0x) for each 32-byte word in the view. */
  readonly wordHexes: readonly string[];
  readonly wordStats: ReadonlyMap<string, WordStats>;
  /** Return the nth 32-byte word (zero-padded on the right if incomplete). */
  getWord(wordIndex: number): Uint8Array;
  /** Return all non-zero byte segments (packed as (s<<8)|e) within the nth 32-byte word. */
  getSegments(wordIndex: number): MemorySegment[];
  mload(offset: number): Uint8Array;
  /**
   * Read an arbitrary slice starting at `offset` for `size` bytes,
   * padding with zeros when reading past `length`.
   */
  slice(offset: number, size: number): Uint8Array;
}

export const initMemoryView = (calldata: string, padding: number): MemoryView => {
  const hex = _normHex(calldata);
  const originalBuf = _hexToUint8Array(hex);
  let buffer = new Uint8Array(padding + originalBuf.length);
  buffer.set(originalBuf, padding);
  const rawLength = buffer.length;
  const wordCount = Math.ceil(rawLength / 32);
  const roundedLength = wordCount * 32;
  if (rawLength !== roundedLength) {
    const rounded = new Uint8Array(roundedLength);
    rounded.set(buffer, 0);
    buffer = rounded;
  }

  const segments: MemorySegment[][] = new Array(wordCount);
  const wordHexes: string[] = new Array(wordCount);
  const wordStats = new Map<string, WordStats>();

  let prevWordHex: string | null = null;
  const wordAt = (wordIndex: number) => {
    const base = wordIndex << 5;
    return buffer.subarray(base, base + 32);
  };

  for (let wordIndex = 0; wordIndex < wordCount; wordIndex++) {
    const base = wordIndex << 5;
    const word = wordAt(wordIndex);

    const wordHex = _uint8ArrayToHex(word);
    wordHexes[wordIndex] = wordHex;
    const existing = wordStats.get(wordHex);
    const isRunContinuation = prevWordHex === wordHex;
    if (!existing) {
      const stats: WordStats = [1, 1, wordIndex, wordIndex, base, base, -1];
      wordStats.set(wordHex, stats);
    } else {
      existing[0] += 1;
      if (!isRunContinuation) existing[1] += 1;
      existing[3] = wordIndex;
      existing[5] = base;
    }
    prevWordHex = wordHex;

    const seg: MemorySegment[] = [];
    for (let i = 0; i < 32; ) {
      while (i < 32 && word[i] === 0) ++i;
      if (i >= 32) break;
      const s = i;
      while (i < 32 && word[i] !== 0) ++i;
      seg.push((s << 8) | (i - 1));
    }
    segments[wordIndex] = seg;
  }

  for (const stats of wordStats.values()) {
    const baseBytes = stats[4] === 0 ? 0 : (32 - Math.clz32(stats[4]) + 7) >> 3;
    const reuseCost = baseBytes + 3;
    stats[6] = 32 > reuseCost ? reuseCost : -1;
  }

  const getWord = (wordIndex: number): Uint8Array => {
    return wordIndex < 0 || wordIndex >= wordCount ? _zeroWord : wordAt(wordIndex);
  };

  const getSegments = (wordIndex: number): MemorySegment[] => {
    return wordIndex < 0 || wordIndex >= wordCount ? _emptySegments : segments[wordIndex];
  };

  const slice = (offset: number, size: number): Uint8Array => {
    if (size <= 0) return new Uint8Array(0);
    const out = new Uint8Array(size);
    if (offset < 0 || offset >= rawLength) return out;
    const end = Math.min(offset + size, rawLength);
    out.set(buffer.subarray(offset, end), 0);
    return out;
  };

  const mload = (offset: number): Uint8Array => slice(offset, 32);

  return {
    hex,
    buffer,
    roundedLength,
    padding,
    dataLength: originalBuf.length,
    wordCount,
    wordHexes,
    wordStats,
    getWord,
    getSegments,
    mload,
    slice,
  };
};
