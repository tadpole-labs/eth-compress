## eth-compress

Compact client-side module for compressing Ethereum JSON-RPC requests, targeting **lower latency** and gas-efficient **read-only calls** with large calldata.

It combines [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-12.5.3)-compliant negotiation for client-to-server compression, with optional JIT-compiled calldata compression for `eth_call`s.

_Plug'n Play with viem & with a simple API_

### Scope
  - Only **read-only** `eth_call`s.
  - Only compresses above a size threshold, and only when it **strictly** reduces request size (HTTP: >1150 bytes; JIT calldata has a similar gate).
  - HTTP uses standard `Content-Encoding` negotiation (e.g. gzip/deflate). EVM mode routes eligible `eth_call`s through a temporary decompressor contract and forwards to the original `to` via state overrides.

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

### Compression modes

| Mode | Behavior |
|------|----------|
| `'passive'` | Discover support from response `Accept-Encoding` header |
| `'proactive'` | Send gzip; discover alternative / lacking support via `Accept-Encoding` response header, error or success |
| `'gzip'` / `'deflate'` | Use specified encoding directly |
| `(payload) => ...` | Custom transform; server expected to understand |

<br>

----
### viem integration

Passive (default):
```ts
import { createPublicClient, http } from 'viem';
import { compressModule } from 'eth-compress';

const client = createPublicClient({
  chain: base,
  transport: http(rpcUrl, { fetchFn: compressModule }),
});
```

Known gzip support:
```ts
import { compressModule } from 'eth-compress';

const client = createPublicClient({
  chain: base,
  transport: http(rpcUrl, {
    fetchFn: (url, init) => compressModule(url, init, 'gzip'),
  }),
});
```

Proactive:
```ts
import { compressModule } from 'eth-compress';

const client = createPublicClient({
  chain: base,
  transport: http(rpcUrl, {
    fetchFn: (url, init) => compressModule(url, init, 'proactive'),
  }),
});
```

JIT calldata compression:
```ts
import { compressModule } from 'eth-compress';
import { compress_call } from 'eth-compress/compressor';

const client = createPublicClient({
  chain: base,
  transport: http(rpcUrl, {
    fetchFn: (url, init) => compressModule(url, init, compress_call),
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

Implemented purely at the application layer: the client rewrites eligible `eth_call`s and injects a JIT decompressor via `stateOverride`/`stateDiff`.

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

`compress_call` can be passed directly to `compressModule` as a custom transform. For eligible `eth_call`s it chooses between:

- **JIT**: Compiles just-in-time, a one-off decompressor contract that reconstructs calldata to forward the call.
- **FLZ / CD**: Uses `LibZip.flzCompress` and `LibZip.cdCompress` from `solady` for fast LZ and calldata RLE compression.

Selection logic (subject to change, but current behaviour):

- **Size gating (JIT / EVM path)**:
  - `< 1150 bytes (effective payload)`: no EVM-level compression.
  - `≥ 1150 bytes`: compression considered.
  - `size ≤ ~3000 bytes or > ~8000 bytes`: JIT is preferred.
  - `~3000 ≤ size ≤ ~8000 bytes`: Best of 3

- **Algorithm choice**:
  - For mid-sized payloads, FLZ and CD are tried and the smaller output is chosen.
  - For larger payloads, JIT is used directly, prioritizing gas efficiency.
  - The thresholds are chosen with consideration for request header overhead & latency,
  aiming to keep the total request size within the [Ethernet MTU](https://en.wikipedia.org/wiki/Maximum_transmission_unit).

### Important considerations

The JIT calldata compressor is **experimental** and intended for read-only `eth_call`s that fetch auxiliary/bulk dApp data (dashboards, analytics, non-critical views). Avoid using it for critical user flows. Ideally you use two viem clients if you intend to use that feature: one with JIT enabled for auxiliary reads, and one without for critical data.

### Compression Ratio & Gas
| Tx Size Range      | # Txns | Avg. Tx Size| JIT Ratio    | FLZ Ratio        | CD Ratio         | JIT Gas         | FLZ Gas         | CD Gas          |
|------------------------|--------|-------------------|:-------------------------:|:----------------:|:----------------:|:---------------:|:---------------:|:---------------:|
| **> 8 KB**             | 129    | 14.90 kb          | 2.99x                     | **3.62x**        | 3.21x            | **8.02k**       | 323k            | 242k            |
| **3–8 KB**             | 260    | 4.82 kb           | 2.77x                     | 2.59x            | **2.81x**        | **4.45k**       | 138k            | 88.9k           |
| **1.15–3 KB**          | 599    | 2.02 kb           | **2.89x**                 | 1.91x            | 2.58x            | **3.35k**       | 68.4k           | 35.8k           |

<sub>Excludes txns not compressible &lt;70% of original size.</sub>

### Compression flavours
- **JIT calldata compiler (`compress_call` JIT mode)**: Views the calldata as a zero‑initialized memory image and synthesises bytecode that rebuilds it word-by-word in-place.

  In the first pass it walks the data in 32-byte slices, detects non-zero segments per word, and for each word chooses the cheapest of three strategies: store a literal tail, assemble segments using SHL/OR, or reuse an earlier word via MLOAD/MSTORE.
  
  In the second pass it materialises this plan into concrete PUSH/MSTORE/SHL/OR/DUP opcodes, pre-seeds the stack with frequently used constants, and appends a small CALL/RETURNDATA stub that forwards the reconstructed calldata to the original `to` address.
  
  The execution is realized through a `stateDiff` passed together with the `eth_call`. The 4‑byte selector is right‑aligned in the first 32‑byte slot so that the rest of the calldata can be reconstructed on mostly word‑aligned boundaries, with the decompressor stateDiff being placed at `0x00000000000000000000000000000000000000e0` such that `0xe0` can be obtained from `ADDRESS` with a single opcode instead of an explicit literal.

Both the FastLZ and calldata-RLE forwarders are minimally adopted from Solady's [`LibZip.sol`](https://github.com/Vectorized/solady/blob/main/src/utils/LibZip.sol) and inlined as raw bytecode. To avoid Solidity's wrapper overhead the code is compiled from pure yul.

