export { createPublicClient, http, parseEther } from 'viem';
export { base } from 'viem/chains';
export { compressModule, MIN_BODY_SIZE } from '../../src/index.ts';
export { compress_call } from '../../src/jit-compressor.ts';
export { runEvmBytecode } from './evm-runner.ts';
export * from './utils.ts';
