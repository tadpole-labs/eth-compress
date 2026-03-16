## eth-compress

A compact client-side module for compressing Ethereum JSON-RPC requests, targeting **lower latency** and gas-efficient **read-only calls** with large calldata.

It combines [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-12.5.3)-compliant negotiation for client-to-server compression, with optional JIT-compiled calldata compression.

_Plug 'n' play with viem and a simple API_

### Scope
  - **Read-only** `eth_call`s.
  - Min. input threshold: > 1150 bytes.
  - HTTP: Uses RFC 9110-compliant `Content-Encoding` negotiation (gzip/deflate).
  - EVM/JIT: Routes `eth_call`s through a transient decompressor contract.

### Installation

```bash
npm i eth-compress
```
---
### HTTP request compression

Transparently compresses request bodies using the [CompressionStream API](https://developer.mozilla.org/en-US/docs/Web/API/CompressionStream).

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
----
### Compatibility
  - Preserves viem semantics: responses and error handling are unchanged; only the request body is compressed.
  - Works in Node and modern browsers that support the CompressionStream API.
    <br><a href="https://caniuse.com/mdn-api_compressionstream">Chrome/Edge ≥ 80; Firefox ≥ 113; Safari/iOS ≥ 16.4</a>

<br>

----

### Calldata compression for `eth_call`

Eligible `eth_call`s are routed through a transient decompressor contract (injected via `stateDiff`).

```ts
import { compress_call } from 'eth-compress/compressor';

const payload = {
  method: 'eth_call',
  params: [{ to: '0x…', data: '0x…' }, 'latest'],
};

const compressedPayload = compress_call(payload);
```

#### Signature

```ts
compress_call(payload, alg?, forward?, revert?, clean_env?)
```

| Param | Type | Default | Description |
|---|---|---|---|
| `payload` | `any` | — | JSON-RPC `eth_call` payload |
| `alg` | `'jit' \| 'flz' \| 'cd'` | auto | Force a specific compression algorithm |
| `forward` | `ForwardMode` | `'call'` | How the decompressor forwards to the target contract |
| `revert` | `boolean` | `false` | If `true`, output data is returned via `REVERT` instead of `RETURN` |
| `clean_env` | `boolean` | `false` | JIT-only: disable environment opcode substitutions (`SELFBALANCE`, `ADDRESS`, `CALLER`, `CALLDATASIZE`) |

#### Forward modes

`ForwardMode` controls what the generated decompressor bytecode does after decompression. All three algorithms (JIT, FLZ, CD) support the same forward modes.

| `forward` | `revert` | Behavior |
|---|---|---|
| `'call'` | `false` | `CALL` target contract, `RETURN` its returndata |
| `'call'` | `true` | `CALL` target contract, `REVERT` with its returndata |
| `'staticcall'` | `false` | `STATICCALL` target, `RETURN` its returndata |
| `'staticcall'` | `true` | `STATICCALL` target, `REVERT` with its returndata |
| `'delegatecall'` | `false` | `DELEGATECALL` target, `RETURN` its returndata |
| `'delegatecall'` | `true` | `DELEGATECALL` target, `REVERT` with its returndata |
| `'none'` | `false` | `RETURN` the decompressed data directly (no forwarding) |
| `'none'` | `true` | `REVERT` with the decompressed data directly (no forwarding) |

When `forward` is `'none'`, `clean_env` is forced on — environment opcode substitutions are disabled since there is no forwarded call context.

#### Examples

Default (CALL + RETURN):
```ts
compress_call(payload);
```

STATICCALL forwarding with FLZ:
```ts
compress_call(payload, 'flz', 'staticcall');
```

DELEGATECALL, revert with returndata:
```ts
compress_call(payload, undefined, 'delegatecall', true);
```

Get decompressed calldata back via REVERT (useful as initcode or for off-chain extraction):
```ts
compress_call(payload, 'jit', 'none', true);
```

#### Algorithm selection

`compress_call` can be passed directly to `compressModule` as a custom transform. For eligible `eth_call`s, it chooses between:

- **JIT**: Compiles a one-off decompressor contract that reconstructs calldata word-by-word.
- **FLZ**: Uses `LibZip.flzCompress` from `solady` for FastLZ (LZ77) compression.
- **CD**: Uses `LibZip.cdCompress` from `solady` for calldata run-length encoding.

- **Size gating**:
  - `< 1150 bytes`: no compression.
  - `≥ 1150 bytes`: compression considered.
  - `< ~3000 or ≥ ~8000 bytes`: JIT preferred (best ratio at small and large sizes).
  - `~3000 – ~8000 bytes`: best of JIT, FLZ, and CD is picked.

- **Algorithm choice**:
  - For mid-sized payloads, FLZ and CD are tried and the smaller output is chosen.
  - For larger ones, JIT is used directly, prioritizing gas efficiency.
  - The thresholds are tuned for total request size, aiming for the [Ethernet MTU](https://en.wikipedia.org/wiki/Maximum_transmission_unit).

### Important considerations

The calldata compressor is **experimental** and intended for auxiliary/bulk dApp read-only `eth_call`s. Use two viem clients to separate concerns.

### Compression Ratio & Gas

| Tx Size Range | # Txns | Avg. Tx Size | JIT Ratio | FLZ Ratio | CD Ratio | JIT Gas | FLZ Gas | CD Gas |
|---|---|---|---|---|---|---|---|---|
| **> 8 KB** | 129 | 14.92 kb | **2.99x** | 3.63x | 2.90x | **8.02k** | 211.87k | 78.02k |
| **3–8 KB** | 260 | 4.82 kb | **2.79x** | 2.61x | 2.29x | **4.45k** | 89.41k | 29.40k |
| **1.15–3 KB** | 599 | 2.02 kb | **2.99x** | 1.99x | 1.80x | **3.38k** | 46.16k | 13.62k |

<sub>Excludes txns not compressible to &lt;70% of its original size.</sub>

### Compression flavors
- **JIT calldata compiler**: Views calldata as a zero‑initialized memory image and synthesizes bytecode that rebuilds it word-by-word in-place.

  In the first pass it walks the data in 32-byte slices, detects non-zero segments per word, and for each word chooses the cheapest of three strategies: store a literal tail, assemble segments using SHL/OR, or reuse an earlier word via MLOAD/MSTORE.

  In the second pass it materializes this plan into concrete PUSH/MSTORE/SHL/OR/DUP opcodes, pre-seeds the stack with frequently used constants, and appends a small CALL/RETURNDATA stub that forwards the reconstructed calldata to the original `to` address.

  The 4‑byte selector is right‑aligned in the first 32‑byte slot so that the rest of the calldata can be reconstructed on mostly word‑aligned boundaries, with the decompressor stateDiff being placed at `0xe0` to obtain this common offset from `ADDRESS` with a single opcode instead of PUSH1 + literal.

- **FastLZ (FLZ)** and **calldata-RLE (CD)** forwarders are minimally adapted from Solady's [`LibZip.sol`](https://github.com/Vectorized/solady/blob/main/src/utils/LibZip.sol) and inlined as raw bytecode compiled from pure Yul. Both support all forwarding modes (`call`, `staticcall`, `delegatecall`) and the `revert` flag, with the target address patched into the bytecode at generation time.

