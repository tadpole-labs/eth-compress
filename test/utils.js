export const BASE_RPC_URL = 'https://mainnet.base.org';

/**
 * Echo Contract
 *
 * Returns whatever calldata it receives.
 * Bytecode breakdown:
 * - CALLDATASIZE (0x36): Get size of calldata
 * - PUSH0 (0x5f): Source offset = 0
 * - PUSH0 (0x5f): Dest offset = 0
 * - CALLDATACOPY (0x37): Copy calldata to memory
 * - CALLDATASIZE (0x36): Get size again for return
 * - PUSH0 (0x5f): Return offset = 0
 * - RETURN (0xf3): Return memory
 */
export const ECHO_CONTRACT_BYTECODE = '0x365f5f37365ff3';
export const ECHO_CONTRACT_ADDRESS = '0x1111111111111111111111111111111111111111';

export function hexToBytes(hex) {
  hex = hex.replace(/^0x/, '');
  if (hex.length % 2 !== 0) hex = '0' + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}
