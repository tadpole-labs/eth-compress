const _sup_enc = new Map<string, string[] | -1>();
const _enc = ['deflate-raw', 'deflate', 'gzip'];
let supported: string | -1 | null = typeof CompressionStream === 'undefined' ? -1 : null;

export type PayloadTransform = (payload: unknown) => unknown;

/**
 * Fetch-compatible function that applies HTTP compression (gzip/deflate) to requests.
 * Optionally transforms request payloads before sending.
 *
 * @param input - The resource URL, Request object, or URL string
 * @param init - Optional request initialization options
 * @param transformPayload - Optional function to transform the request payload
 * @returns A Promise that resolves to the Response
 */
//! @__PURE__
export async function compressModule(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response>;

//! @__PURE__
export async function compressModule(
  input: string | URL | Request,
  init: RequestInit | undefined,
  transformPayload?: PayloadTransform,
): Promise<Response>;

//! @__PURE__
export async function compressModule(
  input: string | URL | Request,
  init?: RequestInit,
  transformPayload?: PayloadTransform,
): Promise<Response> {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

  const cached = _sup_enc.get(url);
  supported = supported === -1 ? -1 : cached === -1 ? -1 : (cached?.[0] ?? null);

  // Only apply the optional payload transform
  // when native HTTP compression is not available for this URL.
  if (transformPayload && init?.body && typeof init.body === 'string') {
    if (supported === -1 || supported === null) {
      try {
        const parsed = JSON.parse(init.body as string);
        const next = transformPayload(parsed);
        if (next !== undefined) {
          init = {
            ...init,
            body: JSON.stringify(next),
          };
        }
      } catch {
        // Non-JSON bodies are left untouched.
      }
    }
  }

  if (supported && supported !== -1 && init?.body) {
    const compressed = await new Response(
      new Blob([init.body as string])
        .stream()
        .pipeThrough(new CompressionStream(supported as CompressionFormat)),
    ).blob();
    init = {
      ...init,
      body: compressed,
      headers: { ...(init && init.headers), 'Content-Encoding': supported },
    };
  }
  const response = await fetch(url, init);

  if (supported === null) {
    const encodings = response.headers
      .get('Accept-Encoding')
      ?.split(',')
      .filter((e) => _enc.includes(e));
    _sup_enc.set(url, encodings?.length ? encodings : -1);
  }

  return response;
}

/**
 * Combines HTTP compression with EVM JIT compression.
 * Just pass this as `fetchFn` to viem's http transport.
 *
 * @param input - The resource URL or Request object
 * @param init - Optional request initialization options
 * @returns A Promise that resolves to the Response
 *
 * @example
 * ```ts
 * const client = createPublicClient({
 *   transport: http(rpcUrl, { fetchFn: compressModuleWithJIT })
 * })
 * ```
 *
 * If the target RPC endpoint and runtime support native HTTP compression,
 * this helper prefers that path and will not apply JIT calldata compression;
 * the JIT-based transform is used as a legacy/fallback path when HTTP
 * content-encoding is unavailable.
 * @pure
 */
//! @__PURE__
export const compressModuleWithJIT = (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  return import('./jit-compressor').then(({ compress_call }) =>
    compressModule(input, init, compress_call),
  );
};
