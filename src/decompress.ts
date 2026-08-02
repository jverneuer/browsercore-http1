/**
 * Content-encoding decompression for HTTP/1.1 responses.
 *
 * Pure function — operates on the full buffered body bytes (after any
 * transfer-encoding has been removed). Uses `node:zlib` for gzip, deflate,
 * and brotli. Kept out of `message.ts` so the message parser stays a pure
 * wire-format function with no dependency on zlib.
 */

import { gunzipSync, inflateSync, inflateRawSync, brotliDecompressSync } from "node:zlib";
import { ContentEncodingError } from "./errors.js";

/** Content-encoding values we can decode — literal union, never bare `string`. */
export type ContentEncoding = "gzip" | "deflate" | "br";

const SUPPORTED_ENCODINGS: readonly ContentEncoding[] = ["gzip", "deflate", "br"];

/** Whether `value` is a content-encoding we know how to decode. */
export function isSupportedContentEncoding(value: string): value is ContentEncoding {
    return (SUPPORTED_ENCODINGS as readonly string[]).includes(value);
}

/**
 * Decompress a body according to a `content-encoding` header value.
 *
 * For `deflate`, servers disagree on framing: some send a zlib-wrapped stream
 * (what the RFC calls for), some send raw deflate. We try zlib first and fall
 * back to raw inflate, matching the de-facto browser tolerance.
 *
 * @throws {ContentEncodingError} on an unsupported value or corrupt stream.
 */
export function decompressBody(body: Uint8Array, encoding: string): Uint8Array {
    switch (encoding) {
        case "gzip":
        case "x-gzip":
            return decompressWith((b) => gunzipSync(b), body, encoding);
        case "deflate": {
            // Try the RFC-mandated zlib-wrapped form first, then raw deflate.
            try {
                return decompressWith((b) => inflateSync(b), body, encoding);
            } catch (zlibErr) {
                if (zlibErr instanceof ContentEncodingError) {
                    return decompressWith((b) => inflateRawSync(b), body, encoding);
                }
                throw zlibErr;
            }
        }
        case "br":
            return decompressWith((b) => brotliDecompressSync(b), body, encoding);
        default:
            throw new ContentEncodingError(encoding);
    }
}

/** Run a zlib sync decoder, normalizing its Buffer output to a Uint8Array. */
function runDecoder(fn: (b: Uint8Array) => Uint8Array | Buffer, body: Uint8Array): Uint8Array {
    const out = fn(body);
    return out instanceof Uint8Array ? out : new Uint8Array(out);
}

/** Run a decoder and wrap any failure in a typed {@link ContentEncodingError}. */
function decompressWith(
    fn: (b: Uint8Array) => Uint8Array | Buffer,
    body: Uint8Array,
    encoding: string,
): Uint8Array {
    try {
        return runDecoder(fn, body);
    } catch (err) {
        // exactOptionalPropertyTypes: only set `cause` when we have one.
        const cause = err instanceof Error ? err : undefined;
        if (cause !== undefined) {
            throw new ContentEncodingError(encoding, { cause });
        }
        throw new ContentEncodingError(encoding);
    }
}
