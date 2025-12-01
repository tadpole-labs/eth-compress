

export const _normHex = (hex: string): string => hex.replace(/^0x/, '').toLowerCase();

export const _hexToUint8Array = (hex: string): Uint8Array => {
  const normalized = _normHex(hex);
  const len = normalized.length;
  const bytes = new Uint8Array(len / 2);
  for (let i = 0; i < len; i += 2) {
    bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
  }
  return bytes;
};

export const _uint8ArrayToHex = (bytes: Uint8Array): string => {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
};

export type MemorySegment = { s: number; e: number };

export interface WordStats {
  /** Total number of times this 32-byte word appears in the view. */
  freq: number;
  normFreq: number;
  /** First 32-byte word index at which this word appears. */
  firstWordIndex: number;
  /** Last 32-byte word index at which this word appears. */
  lastWordIndex: number;
  /** Starting byte offset in memory of the first occurrence (same as MLOAD offset). */
  firstOffset: number;
  /** Starting byte offset in memory of the last occurrence (same as MLOAD offset). */
  lastOffset: number;
  reuseCost: number;
}

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
  /** Frequency of each 32-byte word (by hex representation) across the memory view. */
  readonly wordFreq: ReadonlyMap<string, number>;
  readonly wordStats: ReadonlyMap<string, WordStats>;
  /** Return the nth 32-byte word (zero-padded on the right if incomplete). */
  getWord(wordIndex: number): Uint8Array;
  /**
   * Return all non-zero byte segments within the nth 32-byte word.
   * Each segment is an inclusive [s, e] range in the word.
   */
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
  const buffer = new Uint8Array(padding + originalBuf.length);
  buffer.set(originalBuf, padding);
  const rawLength = buffer.length;
  const wordCount = Math.ceil(rawLength / 32);
  const roundedLength = wordCount * 32;

  const words: Uint8Array[] = new Array(wordCount);
  const segments: MemorySegment[][] = new Array(wordCount);
  const wordFreq = new Map<string, number>();
  const wordStats = new Map<string, WordStats>();

  let prevWordHex: string | null = null;

  for (let wordIndex = 0; wordIndex < wordCount; wordIndex++) {
    const base = wordIndex * 32;
    const word = new Uint8Array(32);
    if (base < rawLength) {
      const end = Math.min(base + 32, rawLength);
      word.set(buffer.subarray(base, end), 0);
    }
    words[wordIndex] = word;

    const wordHex = _uint8ArrayToHex(word);
    const existing = wordStats.get(wordHex);
    const isRunContinuation = prevWordHex === wordHex;
    if (!existing) {
      const stats: WordStats = {
        freq: 1,
        normFreq: 1,
        firstWordIndex: wordIndex,
        lastWordIndex: wordIndex,
        firstOffset: base,
        lastOffset: base,
        reuseCost: -1,
      };
      wordStats.set(wordHex, stats);
      wordFreq.set(wordHex, 1);
    } else {
      existing.freq += 1;
      if (!isRunContinuation) {
        existing.normFreq += 1;
      }
      existing.lastWordIndex = wordIndex;
      existing.lastOffset = base;
      wordFreq.set(wordHex, existing.freq);
    }
    prevWordHex = wordHex;

    const seg: MemorySegment[] = [];
    for (let i = 0; i < 32; ) {
      while (i < 32 && word[i] === 0) ++i;
      if (i >= 32) break;
      const s = i;
      while (i < 32 && word[i] !== 0) ++i;
      seg.push({ s, e: i - 1 });
    }
    segments[wordIndex] = seg;
  }

  for (const stats of wordStats.values()) {
    const baseBytes =
      stats.firstOffset === 0 ? 0 : Math.ceil(Math.log2(stats.firstOffset + 1) / 8);
    const reuseCost = baseBytes + 3;
    const totalLiteralBytes = stats.normFreq * 32;
    const totalReuseBytes = stats.normFreq * reuseCost;
    stats.reuseCost = totalLiteralBytes > totalReuseBytes ? reuseCost : -1;
  }

  const zeroWord = new Uint8Array(32);

  const getWord = (wordIndex: number): Uint8Array => {
    if (wordIndex < 0 || wordIndex >= wordCount) return zeroWord;
    return words[wordIndex];
  };

  const getSegments = (wordIndex: number): MemorySegment[] => {
    if (wordIndex < 0 || wordIndex >= wordCount) return [];
    return segments[wordIndex];
  };

  const mload = (offset: number): Uint8Array => {
    const out = new Uint8Array(32);
    if (offset < 0 || offset >= rawLength) return out;
    const end = Math.min(offset + 32, rawLength);
    out.set(buffer.slice(offset, end), 0);
    return out;
  };

  const slice = (offset: number, size: number): Uint8Array => {
    if (size <= 0) return new Uint8Array(0);
    const out = new Uint8Array(size);
    if (offset < 0 || offset >= rawLength) return out;
    const end = Math.min(offset + size, rawLength);
    out.set(buffer.slice(offset, end), 0);
    return out;
  };

  return {
    hex,
    buffer,
    roundedLength,
    padding,
    dataLength: originalBuf.length,
    wordCount,
    wordFreq,
    wordStats,
    getWord,
    getSegments,
    mload,
    slice,
  };
};

