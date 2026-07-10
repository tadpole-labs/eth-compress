import type { ForwardMode } from './jit.ts';
import { _normHex } from './utils.ts';

const _flzLoop = (a: number, b: number, c: number, d: number, e: number) => {
  const h = (v: number) => v.toString(16).padStart(2, '0');
  return (
    '5b803590815f1a918260051c908160' +
    h(a) +
    '575050906002818360018095013586520101920101906002565b' +
    '600260078396949314958260011a87020194611f0082870193886001011a9160081b16019560018701968503930101945f198301518452808211602083111760' +
    h(b) +
    '575b' +
    '50505001600201906002565b6020811860208211021891825b82811060' +
    h(c) +
    '575060' +
    h(d) +
    '565b8181015f19015185820152830160' +
    h(e) +
    '56'
  );
};

const _rleCore =
  '578082527f' +
  '7f'.repeat(32) +
  '8082168101909117171980157fc0c8c8d0c8e8d0d8c8e8e0e8d0d8e0f0c8d0e8d0e0e0d8f0d0d0e0d8f8f8f8f8' +
  '601f6f8421084210842108cc6318c6db6d54be660204081020408185821060071b' +
  '86811c6001600160401b031060061b1795861c0260181a1c161a90911860031c019081019101368110';

const _rleTail = (a: string, b: string) =>
  '5b50' +
  a +
  '565b90610006565b60029060011a920191608081600101111561' +
  b +
  '575f19825201607e1901368210610006575f91508190' +
  a +
  '565b5f825201600101368210610006575f91508190' +
  a +
  '56';

/** FLZ decompressor/forwarder. */
//! @__PURE__
export const flzFwdBytecode = (
  address: string,
  forward: ForwardMode = 'call',
  revert = false,
): string => {
  const ret = revert ? 'fd' : 'f3';
  if (forward === 'none')
    return '0x5f5f5b368110600c57505f' + ret + _flzLoop(0x35, 0x84, 0x9c, 0x78, 0x91);

  const addr = _normHex(address).padStart(40, '0');
  const d = forward === 'call' ? 1 : 0;
  const h = (v: number) => v.toString(16).padStart(2, '0');
  const op = forward === 'delegatecall' ? 'f4' : forward === 'call' ? 'f1' : 'fa';

  return (
    '0x5f5f5b36811060' +
    h(0x32 + d) +
    '575f808381' +
    (d ? '34' : '') +
    '73' +
    addr +
    '5a' +
    op +
    '3d5f803e60' +
    h(0x2e + d) +
    '573d5ffd5b3d5f' +
    ret +
    _flzLoop(0x5b + d, 0xaa + d, 0xc2 + d, 0x9e + d, 0xb7 + d)
  );
};

/** Calldata RLE decompressor/forwarder. */
//! @__PURE__
export const rleFwdBytecode = (
  address: string,
  forward: ForwardMode = 'call',
  revert = false,
): string => {
  const ret = revert ? 'fd' : 'f3';
  if (forward === 'none')
    return (
      '0x365f80375f365b8151805f1a156100cf' +
      _rleCore +
      '6100c957368111156100c35736900390035b36900336' +
      ret +
      _rleTail('6100bd', '6100fb')
    );

  const addr = _normHex(address).padStart(40, '0');
  const d = forward === 'call' ? 1 : 0;
  const h = (v: number) => v.toString(16).padStart(2, '0');
  const op = forward === 'delegatecall' ? 'f4' : forward === 'call' ? 'f1' : 'fa';

  return (
    '0x365f80375f365b8151805f1a156100' +
    h(0xf8 + d) +
    _rleCore +
    '6100' +
    h(0xf2 + d) +
    '575f918291368111156100' +
    h(0xec + d) +
    '5736900390035b36900336' +
    (d ? '34' : '') +
    '73' +
    addr +
    '5a' +
    op +
    '3d5f803e6100' +
    h(0xe8 + d) +
    '573d5ffd5b3d5f' +
    ret +
    _rleTail('6100c1', '01' + h(0x27 + d))
  );
};
