function hexString(data: unknown) {
  const s = typeof data === 'string' ? data : String(data);
  return s.startsWith('0x') || s.startsWith('0X') ? s.toLowerCase() : '0x' + s.toLowerCase();
}

function byteToString(b: number) {
  return (b & 0xff).toString(16).padStart(2, '0');
}

function parseByte(data: string, i: number) {
  return Number.parseInt(data.slice(i, i + 2), 16);
}

function _hexToBytes(hex: string) {
  const s = hexString(hex).slice(2);
  const out = new Uint8Array(s.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function _bytesToHex(bytes: ArrayLike<number>) {
  let out = '0x';
  for (let i = 0; i < bytes.length; i++) out += byteToString(bytes[i]!);
  return out;
}

function hexBody(data: unknown) {
  const body = hexString(data).slice(2);
  if (body.length % 2 !== 0) throw new Error('Hex string length must be a multiple of 2.');
  return body;
}

export function flzCompress(data: unknown) {
  var ib = Array.from(_hexToBytes(hexString(data))),
    b = ib.length - 4;
  var ht: number[] = [],
    ob: number[] = [],
    a = 0,
    i = 2,
    o = 0,
    j: number,
    s: number,
    h: number,
    d: number,
    c: number,
    l: number,
    r: number,
    p: number,
    q: number,
    e: number;

  function u24(i: number) {
    return ib[i]! | (ib[++i]! << 8) | (ib[++i]! << 16);
  }

  function hash(x: number) {
    return ((2654435769 * x) >> 19) & 8191;
  }

  function literals(r: number, s: number) {
    while (r >= 32) for (ob[o++] = 31, j = 32; j--; r--) ob[o++] = ib[s++]!;
    if (r) for (ob[o++] = r - 1; r--; ) ob[o++] = ib[s++]!;
  }

  while (i < b - 9) {
    do {
      r = ht[(h = hash((s = u24(i))))] || 0;
      c = (d = (ht[h] = i) - r) < 8192 ? u24(r) : 0x1000000;
    } while (i < b - 9 && i++ && s != c);
    if (i >= b - 9) break;
    if (--i > a) literals(i - a, a);
    for (l = 0, p = r + 3, q = i + 3, e = b - q; l < e; l++) e *= ib[p + l] === ib[q + l] ? 1 : 0;
    i += l;
    for (--d; l > 262; l -= 262) (ob[o++] = 224 + (d >> 8)), (ob[o++] = 253), (ob[o++] = d & 255);
    if (l < 7) (ob[o++] = (l << 5) + (d >> 8)), (ob[o++] = d & 255);
    else (ob[o++] = 224 + (d >> 8)), (ob[o++] = l - 7), (ob[o++] = d & 255);
    ht[hash(u24(i))] = i++;
    ht[hash(u24(i))] = i++;
    a = i;
  }
  literals(b + 4 - a, a);
  return _bytesToHex(ob);
}

export function cdCompress(data: unknown) {
  const body = hexBody(data);
  var o = '0x',
    z = 0,
    y = 0,
    i = 0,
    c: number;

  function pushByte(b: number) {
    o += byteToString((o.length < 10 ? 0xff : 0x00) ^ b);
  }

  function rle(v: number, d: number) {
    pushByte(0x00);
    pushByte(d - 1 + v * 0x80);
  }

  for (; i < body.length; i += 2) {
    c = parseByte(body, i);
    if (!c) {
      if (y) rle(1, y), (y = 0);
      if (++z === 0x80) rle(0, 0x80), (z = 0);
      continue;
    }
    if (c === 0xff) {
      if (z) rle(0, z), (z = 0);
      if (++y === 0x20) rle(1, 0x20), (y = 0);
      continue;
    }
    if (y) rle(1, y), (y = 0);
    if (z) rle(0, z), (z = 0);
    pushByte(c);
  }
  if (y) rle(1, y), (y = 0);
  if (z) rle(0, z), (z = 0);
  return o;
}
