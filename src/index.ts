export const MIN_BODY_SIZE = 1150;

const _cache = new Map<string, string | -1>();
const _enc = ['gzip', 'deflate'] as const;
type SupportedEncoding = (typeof _enc)[number];

export type PayloadTransform = (payload: unknown) => unknown;
export type CompressionMode = 'passive' | 'proactive' | 'gzip' | 'deflate' | PayloadTransform;

/**
 * @param input - URL or Request
 * @param init - Request options
 * @param mode - Compression mode:
 *   - 'passive' (default): discover support via Accept-Encoding header first
 *   - 'proactive': compress with gzip first, adjust if server rejects
 *   - 'gzip' | 'deflate': use specified encoding directly (known support)
 *   - PayloadTransform function: transform payload, skip HTTP compression
 */
export async function compressModule(
  input: string | URL | Request,
  init?: RequestInit,
  mode?: CompressionMode,
): Promise<Response> {
  const req = input instanceof Request ? input : null;
  const url =
    typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
  const bodyStr = typeof init?.body === 'string' ? init.body : null;

  // Custom transform: apply and skip HTTP compression
  if (typeof mode === 'function') {
    if (req && !init) return fetch(req);
    let body = init?.body;
    if (bodyStr)
      try {
        const next = mode(JSON.parse(bodyStr));
        if (next !== undefined) body = JSON.stringify(next);
      } catch {}
    return fetch(req ?? url, { ...init, body });
  }

  const cached = _cache.get(url);
  const hasCS = typeof CompressionStream !== 'undefined';
  const known = mode === 'gzip' || mode === 'deflate';
  const encoding = !hasCS
    ? null
    : known
      ? (mode as SupportedEncoding)
      : mode === 'proactive'
        ? cached === -1
          ? null
          : (cached ?? 'gzip')
        : typeof cached === 'string'
          ? cached
          : null;

  const shouldCompress = !!encoding && !!bodyStr && bodyStr.length >= MIN_BODY_SIZE;
  const opts: RequestInit = { ...init, priority: 'high' as RequestPriority };
  const headers = new Headers(opts.headers);
  if (shouldCompress) {
    opts.body = await new Response(
      new Blob([bodyStr!])
        .stream()
        .pipeThrough(new CompressionStream(encoding as CompressionFormat)),
    ).blob();
    headers.set('Content-Encoding', encoding);
  }
  opts.headers = headers;

  const response = await fetch(req ?? url, opts);

  // Cache discovery for passive/proactive (not known modes)
  if (!known && cached === undefined) {
    const header = response.headers.get('Accept-Encoding');
    const discovered =
      header
        ?.split(',')
        .map((e) => e.trim())
        .find((e): e is SupportedEncoding => _enc.includes(e as SupportedEncoding)) ?? -1;
    _cache.set(
      url,
      mode === 'proactive' && shouldCompress ? (response.ok ? encoding! : discovered) : discovered,
    );
  }

  return response;
}
