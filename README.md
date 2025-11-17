## eth-compress

Compact client-side module for compressing Ethereum JSON-RPC requests.

It combines HTTP body compression with optional JIT-compiled calldata compression for `eth_call`, targeting **lower latency** and gas-efficient **read-only calls** with large calldata.

### Scope
  - **Only read-only `eth_call`'s are considered**
  - Compression is only attempted above a size threshold (currently 800 bytes), and only applied if it strictly reduces total request size.
  - The transform re-targets the call through a decompressor contract and forwards calldata to the original `to` address.
  - For reference: Large eth_call's >70kb at a <40% compression ratio result in roughly 30-40% latency reduction. (precise benefits largely depend on a variety of factors, non-the-less the said estimate is a sane projection for the average case)

### Installation

```bash
npm i eth-compress
```
---
### HTTP request compression

`eth-compress` exposes a `fetch`-compatible function that transparently compresses JSON-RPC request bodies using standard HTTP content-encoding.

```ts
import { compressModule } from 'eth-compress';

const response = await compressModule('https://rpc.example.org', {
  method: 'POST',
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [/* ... */],
  }),
});
```

### How it works

  - On the first request to a given RPC URL, inspects the `Accept-Encoding` response header to discover supported encodings, then compresses subsequent request bodies via
     [`CompressionStreams API`](https://developer.mozilla.org/en-US/docs/Web/API/Compression_Streams_API)
     (browser) or a [Node.js polyfill](https://github.com/tadpole-labs/eth-compress/blob/main/src/index.node.ts).
  - Designed as the client-side piece for future client-to-server compression support in RPC nodes;
  - Falls back to plain `fetch` & EVM-based compression if not supported by the RPC (see below).

<br>

----
### viem integration

`compressModule` and `compressModuleWithJIT` can be used as drop-in `fetchFn` modules for viem's `http` transport.

```ts
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { compressModule, compressModuleWithJIT } from 'eth-compress';

// HTTP compression only
const httpCompressedClient = createPublicClient({
  chain: base,
  transport: http(rpcUrl, {
    fetchFn: compressModule,
  }),
});

// HTTP compression + eth_call JIT calldata compression
const jitCompressedClient = createPublicClient({
  chain: base,
  transport: http(rpcUrl, {
    fetchFn: compressModuleWithJIT,
  }),
});
```
#### thats it.
----
### Compatibility
  - Preserves viem semantics: responses and error handling are unchanged; only the request path is compressed.
  - Works in Node and modern browsers that support the `CompressionStreams API` (Chrome/Edge ≥ 80, Firefox ≥ 113, Safari/iOS ≥ 16.4).

<br>

----

### eth_call JIT calldata compression

For backwards compatibility and immediate benefit, calldata compression is implemented on the application layer: requests are rewritten client-side and executed as usual by existing nodes.
The goal here is the same: **reduce request size -> latency** for large `eth_call` payloads, and secondarily to **stay under eth_call gas/memory limits** by reducing calldata size and gas footprint.

```ts
import { compress_call } from 'eth-compress/compressor';

const payload = {
  method: 'eth_call',
  params: [
    {
      to: '0x…',
      data: '0x…', // potentially large calldata
    },
    'latest',
  ],
};

const compressedPayload = compress_call(payload); // safe to send instead of `payload`
```

`compress_call` can be used directly or via `compressModuleWithJIT` (which feeds it into `compressModule` as a payload transform).
For eligible `eth_call`s it chooses between:

- **JIT**: Compiles just-in-time, a one-off decompressor contract that reconstructs calldata to forward the call.
- **FLZ / CD**: Uses `LibZip.flzCompress` and `LibZip.cdCompress` from `solady` for fast LZ and calldata RLE compression.

Selection logic (subject to change, but current behaviour):

- **Size gating**:
  - `< 800 bytes`: no compression.
  - `≥ 800 bytes`: compression considered.
  - `≥ 4096 bytes`: JIT is preferred.
- **Algorithm choice**:
  - For mid-sized payloads, FLZ and CD are tried and the smaller output is chosen.
  - For larger payloads, JIT is used directly, focusing on gas-efficient decompression.


### Implementation notes & compression flavours
- **JIT calldata compiler (`compress_call` JIT mode)**: Views the calldata as a zero‑initialized memory image and synthesises bytecode that rebuilds it word-by-word in-place. In the first pass it walks the data in 32-byte slices, detects non-zero segments per word, and for each word chooses the cheapest of three strategies: store a literal tail, assemble segments using SHL/OR, or reuse an earlier word via MLOAD/MSTORE, under a rough opcode-count cost model. In the second pass it materialises this plan into concrete PUSH/MSTORE/SHL/OR/DUP opcodes, pre-seeds the stack with frequently used constants, and appends a small CALL/RETURNDATA stub that forwards the reconstructed calldata to the original `to` address. The execution is realized through a `stateDiff` passed together with the eth_call. Achieves compression ratios comparable to FastLZ / Run-Length-Encoding.
- **FastLZ path (`LibZip.flzCompress` / `flzDecompress`)**: Implements a minimal LZ77-style compressor over raw bytes with a 3-byte rolling window. Each 24-bit chunk is hashed into a tiny table; repeated substrings within a bounded look-back distance are emitted as (length, distance) match tokens, and everything else is emitted as literal runs. Decompression is a simple loop over this stream that copies literals and then copies `length` bytes from `distance` bytes back in the already-produced output.
- **Calldata RLE path (`LibZip.cdCompress` / `cdDecompress`)**: Targets the two most common runs in calldata—long stretches of `0x00` and shorter stretches of `0xff`—and turns them into compact `[marker][control]` pairs, where the control byte encodes which value and how many repetitions to emit. Bytes that are not part of such runs are left verbatim, so the decoder can just scan the stream and either expand a run or forward a single byte.

Both the FastLZ and calldata-RLE forwarders are minimally adopted from Solady's [`LibZip.sol`](https://github.com/Vectorized/solady/blob/main/src/utils/LibZip.sol) and inlined as raw bytecode. To avoid Solidity's wrapper overhead the code is compiled from pure yul.

