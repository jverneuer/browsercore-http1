/**
 * Content-encoding decompression for HTTP/1.1 responses.
 *
 * Pure function — operates on the full buffered body bytes (after any
 * transfer-encoding has been removed). http1 does NOT own a zlib backend — a
 * {@link DecompressionProvider} is injected by the caller (typically
 * @browsercore/fetch) so this package never imports @browsercore/compression
 * directly (that was a layering violation: http1 composes over @browsercore/*
 * packages *below* it; compression is a sibling, reached only via fetch).
 * Any failure to decompress is mapped onto HTTP/1.1's
 * {@link ContentEncodingError} — the original provider error is preserved as
 * `cause` so nothing is hidden.
 *
 * Kept out of `message.ts` so the message parser stays a pure wire-format
 * function with no dependency on zlib.
 */

import { ContentEncodingError } from "./errors.js";

/**
 * The decompression backend seam.
 *
 * http1 depends only on this interface, never on a concrete zlib provider.
 * The caller (typically @browsercore/fetch) injects an implementation —
 * usually the `@browsercore/compression` singleton. `decompress` receives the
 * full body bytes and the `content-encoding` header value and must return the
 * decoded bytes; it may throw on an unsupported or corrupt stream (http1 wraps
 * any thrown error as a {@link ContentEncodingError}).
 */
export interface DecompressionProvider {
    /** Decompress a body according to a `content-encoding` header value. */
    decompress(data: Uint8Array, encoding: string): Uint8Array;
}

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
 * (what the RFC calls for), some send raw deflate. The injected provider is
 * expected to mirror browser tolerance (try zlib first, fall back to raw).
 *
 * @throws {ContentEncodingError} on any decompression failure — the original
 *   provider error is attached as `cause`.
 */
export function decompressBody(
    body: Uint8Array,
    encoding: string,
    provider: DecompressionProvider,
): Uint8Array {
    try {
        return provider.decompress(body, encoding);
    } catch (err) {
        // Normalize non-Error throws (a provider may throw anything) into an
        // Error before attaching as cause, so the contract holds either way.
        const cause = err instanceof Error ? err : new Error(String(err));
        throw new ContentEncodingError(encoding, { cause });
    }
}
