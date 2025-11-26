## eth-compress

Compact client-side module for compressing Ethereum JSON-RPC requests, targeting **lower latency** and gas-efficient **read-only calls** with large calldata.

It combines [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-12.5.3)-compliant negotiation for client-to-server compression, with optional JIT-compiled calldata compression for `eth_call`s.

_Plug'n Play with viem & with a simple API_

### Scope
  - **Only read-only `eth_call`'s are considered**
  - Compression is only attempted above a size threshold (currently 1150 bytes of JSON body for HTTP compression, and similarly gated for JIT calldata compression), and only applied if it strictly reduces total request size.
  - The HTTP path uses standard `Content-Encoding` (e.g. gzip/deflate) negotiation; the EVM path rewrites eligible `eth_call`s through a transient decompressor contract and forwards calldata to the original `to` address via state overrides.
  - For reference: Large `eth_call`s >70kb that compress to about **40% smaller payload size** (i.e. ~60% of the original bytes on the wire) can see roughly 30–40% latency reduction. (Precise benefits depend on many factors; this is a reasonable average-case projection.)

### Installation

```bash
npm i eth-compress
```
---
### HTTP request compression (transport-level)

`eth-compress` exposes a `fetch`-compatible function that transparently compresses JSON-RPC request bodies using the CompressionStreams API, when the target RPC endpoint supports it and the payload is large enough to benefit.

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

// HTTP compression only (transport-level)
const httpCompressedClient = createPublicClient({
  chain: base,
  transport: http(rpcUrl, {
    fetchFn: compressModule,
  }),
});

// HTTP compression + optional eth_call JIT calldata compression (application-level)
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

### eth_call JIT calldata compression (application-level)

For backwards compatibility and immediate benefit, calldata compression is implemented purely at the application layer: requests are rewritten client-side and executed as usual by existing nodes, using a just-in-time compiled decompressor contract that is injected via `stateOverride`/`stateDiff`.
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

`compress_call` can be used directly or via `compressModuleWithJIT` (which feeds it into `compressModule` as a payload transform when HTTP content-encoding is not available for the target URL).
For eligible `eth_call`s it chooses between:

- **JIT**: Compiles just-in-time, a one-off decompressor contract that reconstructs calldata to forward the call.
- **FLZ / CD**: Uses `LibZip.flzCompress` and `LibZip.cdCompress` from `solady` for fast LZ and calldata RLE compression.

Selection logic (subject to change, but current behaviour):

- **Size gating (JIT / EVM path)**:
  - `< 1150 bytes (effective payload)`: no EVM-level compression.
  - `≥ 1150 bytes`: compression considered.
  - `size ≤ ~3000 bytes or > ~8000 bytes`: JIT is preferred.
  - `~3000 ≤ size ≤ ~8000 bytes`: FastLZ or RLE.

- **Algorithm choice**:
  - For mid-sized payloads, FLZ and CD are tried and the smaller output is chosen.
  - For larger payloads, JIT is used directly, focusing on gas-efficient decompression.
  - The thresholds are chosen with consideration for request header overhead & latency,
  aiming to keep the total request size within the [Ethernet MTU](https://en.wikipedia.org/wiki/Maximum_transmission_unit).



### Important considerations

The JIT calldata compressor is **experimental** and targets efficient compression of **read-only `eth_call`s for auxiliary dApp data loaded in bulk** (e.g. dashboards, analytics, non-critical views). It is **not recommended** for on-chain deployment or for critical paths in dApp flows that directly influence user operations. For separation of concerns, it is recommended to initialize **one client for auxiliary data** (with JIT compression enabled) and **another client for user operations**, and perform a separate requests for user‑facing operations.


### Implementation notes & compression flavours
- **JIT calldata compiler (`compress_call` JIT mode)**: Views the calldata as a zero‑initialized memory image and synthesises bytecode that rebuilds it word-by-word in-place.

  In the first pass it walks the data in 32-byte slices, detects non-zero segments per word, and for each word chooses the cheapest of three strategies: store a literal tail, assemble segments using SHL/OR, or reuse an earlier word via MLOAD/MSTORE, under a rough opcode-count cost model.
  
  In the second pass it materialises this plan into concrete PUSH/MSTORE/SHL/OR/DUP opcodes, pre-seeds the stack with frequently used constants, and appends a small CALL/RETURNDATA stub that forwards the reconstructed calldata to the original `to` address.
  
  The execution is realized through a `stateDiff` passed together with the `eth_call`. The 4‑byte selector is right‑aligned in the first 32‑byte slot so that the rest of the calldata can be reconstructed on mostly word‑aligned boundaries, with the decompressor stateDiff being placed at `0x00000000000000000000000000000000000000e0` such that `0xe0` can be obtained from `ADDRESS` with a single opcode instead of an explicit literal.
  
  Achieves higher compression ratios compared to both FastLZ & Run-Length-Encoding (around 10–15% **smaller payloads**) for smaller calldata <3kb, and on par above 8kb (except in cases with deeply nested calls and types, minimally worse), at a fraction of the gas footprint (<5%).

- **FastLZ path (`LibZip.flzCompress` / `flzDecompress`)**: Implements a minimal LZ77-style compressor over raw bytes with a 3-byte rolling window. Each 24-bit chunk is hashed into a tiny table; repeated substrings within a bounded look-back distance are emitted as (length, distance) match tokens, and everything else is emitted as literal runs. Decompression is a simple loop over this stream that copies literals and then copies `length` bytes from `distance` bytes back in the already-produced output.

- **Calldata RLE path (`LibZip.cdCompress` / `cdDecompress`)**: Targets the two most common runs in calldata—long stretches of `0x00` and shorter stretches of `0xff`—and turns them into compact `[marker][control]` pairs, where the control byte encodes which value and how many repetitions to emit. Bytes that are not part of such runs are left verbatim, so the decoder can just scan the stream and either expand a run or forward a single byte.

Both the FastLZ and calldata-RLE forwarders are minimally adopted from Solady's [`LibZip.sol`](https://github.com/Vectorized/solady/blob/main/src/utils/LibZip.sol) and inlined as raw bytecode. To avoid Solidity's wrapper overhead the code is compiled from pure yul.

