import zlib from 'node:zlib';

// Polyfill for CompressionStream/DecompressionStream in Node.js
const make = (ctx: any, handle: any) =>
  Object.assign(ctx, {
    writable: new WritableStream({
      write(chunk) {
        handle.write(chunk);
        return Promise.resolve();
      },
      close() {
        handle.end();
        return Promise.resolve();
      },
    }),
    readable: new ReadableStream({
      type: 'bytes',
      start(ctrl) {
        handle.on('data', (chunk: any) => ctrl.enqueue(chunk));
        handle.once('end', () => ctrl.close());
      },
    }),
  });

if (!globalThis.CompressionStream) {
  globalThis.CompressionStream = class CompressionStream {
    constructor(format: string) {
      let handle;
      if (format === 'deflate') {
        handle = zlib.createDeflate();
      } else if (format === 'gzip') {
        handle = zlib.createGzip();
      } else if (format === 'br') {
        handle = zlib.createBrotliCompress();
      } else {
        handle = zlib.createDeflateRaw();
      }
      make(this, handle);
    }
  } as any;
}

if (!globalThis.DecompressionStream) {
  globalThis.DecompressionStream = class DecompressionStream {
    constructor(format: string) {
      let handle;
      if (format === 'deflate') {
        handle = zlib.createInflate();
      } else if (format === 'gzip') {
        handle = zlib.createGunzip();
      } else if (format === 'br') {
        handle = zlib.createBrotliDecompress();
      } else {
        handle = zlib.createInflateRaw();
      }
      make(this, handle);
    }
  } as any;
}

export * from './index';
