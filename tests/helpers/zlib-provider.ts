/**
 * Test-only {@link DecompressionProvider} backed by `node:zlib`.
 *
 * @browsercore/compression no longer ships a singleton instance — the concrete
 * backend now lives in the composition root (browsersmith). These tests need a
 * real decompression backend to verify http1's content-encoding handling, so we
 * build one here from `node:zlib`, mirroring the browser-tolerant deflate
 * strategy (try zlib-wrapped, fall back to raw deflate) the production backend
 * implements.
 */

import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import type { DecompressionProvider } from "../../src/decompress.js";

/**
 * A {@link DecompressionProvider} that decodes gzip, x-gzip, deflate (zlib or
 * raw), and brotli via `node:zlib`. Throws on any other encoding so the
 * surrounding {@link decompressBody} wraps it as a {@link ContentEncodingError}.
 */
export const zlibDecompressionProvider: DecompressionProvider = {
    decompress(data: Uint8Array, encoding: string): Uint8Array {
        const normalized = encoding.trim().toLowerCase();
        switch (normalized) {
            case "gzip":
            case "x-gzip":
                return new Uint8Array(gunzipSync(data));
            case "deflate": {
                // Servers disagree on framing: some send zlib-wrapped, some raw.
                // Browsers try zlib first, then fall back to raw deflate.
                try {
                    return new Uint8Array(inflateSync(data));
                } catch {
                    return new Uint8Array(inflateRawSync(data));
                }
            }
            case "br":
                return new Uint8Array(brotliDecompressSync(data));
            default:
                throw new Error(`unsupported content-encoding: ${encoding}`);
        }
    },
};
