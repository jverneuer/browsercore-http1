/**
 * Content-encoding decompression for HTTP/1.1 responses.
 *
 * Pure function — operates on the full buffered body bytes (after any
 * transfer-encoding has been removed). Delegates to `@browsercore/compression`
 * so the zlib backend is replaceable; maps the provider's typed errors onto
 * HTTP/1.1's `ContentEncodingError` to preserve this package's public contract.
 *
 * Kept out of `message.ts` so the message parser stays a pure wire-format
 * function with no dependency on zlib.
 */

import {
    compression,
    DecompressionError,
    UnsupportedEncodingError,
} from "@browsercore/compression";
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
 * (what the RFC calls for), some send raw deflate. The underlying provider
 * tries zlib first and falls back to raw inflate, matching the de-facto
 * browser tolerance.
 *
 * @throws {ContentEncodingError} on an unsupported value or corrupt stream.
 */
export function decompressBody(body: Uint8Array, encoding: string): Uint8Array {
    try {
        return compression.decompress(body, encoding);
    } catch (err) {
        // The provider throws its own typed errors; re-wrap as http1's
        // ContentEncodingError so this package's public contract is stable.
        if (err instanceof UnsupportedEncodingError) {
            throw new ContentEncodingError(err.encoding, { cause: err });
        }
        if (err instanceof DecompressionError) {
            throw new ContentEncodingError(err.encoding, { cause: err });
        }
        throw err;
    }
}
