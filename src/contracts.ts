import { _normHex } from './compiler/utils';

/**
 * Generates FastLZ (LZ77) decompressor bytecode. The generated code decompresses incoming calldata and forwards it to the target address.
 * @param address - Target contract address
 * @see {@link https://github.com/Vectorized/solady/blob/main/src/utils/LibZip.sol}
 * @pure
 */
//! @__PURE__
export const flzFwdBytecode = (address: string): string =>
  `0x365f73${_normHex(address)}815b838110602f575f80848134865af1503d5f803e3d5ff35b803590815f1a8060051c908115609857600190600783149285831a6007018118840218600201948383011a90601f1660081b0101808603906020811860208211021890815f5b80830151818a015201858110609257505050600201019201916018565b82906075565b6001929350829150019101925f5b82811060b3575001916018565b85851060c1575b60010160a6565b936001818192355f1a878501530194905060ba56`;

/**
 * Generates RLE (run-length encoded) decompressor bytecode. The generated code decompresses incoming calldata and forwards it to the target address.
 * @param address - Target contract address
 * @see {@link https://github.com/Vectorized/solady/blob/main/src/utils/LibZip.sol}
 * @pure
 */
//! @__PURE__
export const rleFwdBytecode = (address: string): string =>
  `0x5f5f5b368110602d575f8083813473${_normHex(address)}5af1503d5f803e3d5ff35b600180820192909160031981019035185f1a8015604c57815301906002565b505f19815282820192607f9060031981019035185f1a818111156072575b160101906002565b838101368437606a56`;
