/**
 * HTTP/1.1 message parser and serializer.
 *
 * Pure protocol logic — no I/O. Takes and returns `Uint8Array` so it can be
 * tested in isolation and composed over any byte stream.
 */

import type { HttpRequest, HttpResponse } from "./types.js";
import { InvalidResponseError, ChunkEncodingError } from "./errors.js";
import { assertNever } from "./utils.js";

/** The start-line of an HTTP/1.1 message — discriminated by direction. */
export type StartLine =
    | { readonly kind: "request"; readonly method: string; readonly target: string; readonly version: string }
    | { readonly kind: "status"; readonly version: string; readonly statusCode: number; readonly statusText: string };

/** Parsed headers — case-insensitive map. */
export type Headers = ReadonlyMap<string, string>;

/** Parse result for a response — includes bytes consumed so the caller can drain. */
export interface ParseResponseResult {
    readonly response: HttpResponse;
    readonly bytesConsumed: number;
}

/**
 * Serialize an HTTP/1.1 request into wire bytes.
 *
 * Produces `request-line CRLF headers CRLF body` per RFC 7230. The body is
 * appended verbatim — chunking and content-length are the caller's concern.
 */
export function serializeRequest(req: HttpRequest): Uint8Array {
    const lines: string[] = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [name, value] of req.headers) {
        // node:http lowercases header names on the wire (RFC 7230 §3.2); match it.
        lines.push(`${name.toLowerCase()}: ${value}`);
    }
    lines.push("", "");
    const headerBytes = Buffer.from(lines.join("\r\n"), "ascii");
    switch (req.body.kind) {
        case "empty":
            return new Uint8Array(headerBytes);
        case "bytes": {
            const out = new Uint8Array(headerBytes.length + req.body.data.length);
            out.set(new Uint8Array(headerBytes), 0);
            out.set(req.body.data, headerBytes.length);
            return out;
        }
        default:
            return assertNever(req.body);
    }
}

/**
 * Parse a raw HTTP/1.1 response from a buffer.
 *
 * Returns the parsed response plus the number of bytes consumed so the caller
 * can drain the buffer before the next message (keep-alive).
 *
 * @throws {InvalidResponseError} if the bytes cannot be parsed as a response.
 */
export function parseResponse(buf: Uint8Array): ParseResponseResult {
    const text = Buffer.from(buf).toString("ascii");
    const headerEnd = text.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
        throw new InvalidResponseError(text.slice(0, 120));
    }
    const headerSection = text.slice(0, headerEnd);
    const bodyStart = headerEnd + 4;
    // The status line ends at the first CRLF; the rest are header-field lines.
    // (split always returns a non-empty array, so indexing is safe at runtime.)
    const firstLineEnd = headerSection.indexOf("\r\n");
    const statusLine = firstLineEnd >= 0 ? headerSection.slice(0, firstLineEnd) : headerSection;
    const statusMatch = /^HTTP\/\d\.\d\s+(\d{3})\s+(.*)$/u.exec(statusLine);
    if (statusMatch === null) {
        throw new InvalidResponseError(text.slice(0, 120));
    }
    // The regex groups always participate when the match succeeds.
    const statusCodeStr = statusMatch[1] ?? "0";
    const statusText = statusMatch[2] ?? "";
    const statusCode = Number(statusCodeStr);
    // The regex captures exactly three digits (000-999); reject anything below
    // the valid 100-999 range. The > 999 arm is unreachable but kept defensive.
    if (statusCode < 100 || statusCode > 999) {
        throw new InvalidResponseError(text.slice(0, 120));
    }
    const headers = new Map<string, string>();
    for (const line of headerSection.split("\r\n").slice(1)) {
        const colon = line.indexOf(":");
        if (colon === -1) {
            continue;
        }
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        headers.set(name, value);
    }
    const contentLengthHeader = headers.get("content-length");
    const transferEncoding = headers.get("transfer-encoding");
    let body: Uint8Array;
    if (transferEncoding !== undefined && transferEncoding.includes("chunked")) {
        // Chunked decoding is handled by parseChunkedEncoding — here we just
        // return the raw body bytes for the caller to feed through that.
        body = buf.slice(bodyStart);
    } else if (headers.has("content-length")) {
        const contentLength = Number(contentLengthHeader);
        body = buf.slice(bodyStart, bodyStart + contentLength);
    } else {
        body = buf.slice(bodyStart);
    }
    const response: HttpResponse = {
        statusCode,
        statusText,
        headers,
        body,
    };
    const bytesConsumed = bodyStart + body.length;
    return { response, bytesConsumed };
}

/**
 * Decode a chunked transfer-encoding body stream.
 *
 * Reads from an `AsyncIterable<Uint8Array>` of the raw body bytes (after the
 * headers) and yields the decoded content bytes chunk by chunk. Parses the
 * hex chunk-size line (with optional `;` extensions), verifies the per-chunk
 * `CRLF`, and stops at the terminating zero chunk — consuming any optional
 * trailers and the final blank line.
 *
 * Streaming: a chunk is yielded as soon as its full `size + CRLF` is available
 * in the buffer, so a producer can pipe network bytes through without buffering
 * the whole body.
 *
 * @throws {ChunkEncodingError} (with `offset`) if a chunk is malformed.
 */
export async function* parseChunkedEncoding(stream: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    // Bytes buffered from the stream but not yet parsed into a complete chunk.
    let buffer = new Uint8Array(0);
    // Total body bytes consumed so far — reported as the error offset.
    let consumed = 0;

    const append = (chunk: Uint8Array): void => {
        if (chunk.length === 0) {
            return;
        }
        const next = new Uint8Array(buffer.length + chunk.length);
        next.set(buffer, 0);
        next.set(chunk, buffer.length);
        buffer = next;
    };

    // Find the next `CRLF` at or after `start`; return the index of the `CR`.
    const findCrlf = (start: number): number => {
        for (let i = start; i + 1 < buffer.length; i++) {
            if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a) {
                return i;
            }
        }
        return -1;
    };

    // Consume the trailer section (zero or more header lines + blank line).
    // Returns the offset just past the terminating blank line, or -1 if the
    // buffer does not yet hold the full trailer section.
    const consumeTrailers = (start: number): number => {
        let lineStart = start;
        for (let i = start; i + 1 < buffer.length; i++) {
            if (buffer[i] !== 0x0d || buffer[i + 1] !== 0x0a) {
                continue;
            }
            if (i === lineStart) {
                // Blank line — end of trailers.
                return i + 2;
            }
            lineStart = i + 2;
        }
        return -1;
    };

    for await (const chunk of stream) {
        append(chunk);
        // Emit as many complete chunks as the buffer currently holds.
        // Loop because a single pushed chunk may contain several full chunks.
        drain:
        while (true) {
            const lineEnd = findCrlf(0);
            if (lineEnd === -1) {
                break drain; // Need more bytes for the size line.
            }

            const sizeLine = decodeAscii(buffer, 0, lineEnd);
            // chunk-size [ ";" chunk-ext ] — hex digits then optional extension.
            // exec returns null (not undefined) when there is no match.
            if (!/^[0-9a-fA-F]+(?:;[^\r\n]*)?$/u.test(sizeLine)) {
                throw new ChunkEncodingError(consumed);
            }
            const size = Number.parseInt(sizeLine, 16);
            const dataStart = lineEnd + 2;

            if (size === 0) {
                // Terminating chunk is just `0\r\n`; optional trailers + a final
                // blank line follow. dataStart points past the `0\r\n`.
                const trailerEnd = consumeTrailers(dataStart);
                if (trailerEnd === -1) {
                    break drain; // Need more bytes for trailers.
                }
                consumed += trailerEnd;
                return;
            }

            const dataEnd = dataStart + size;
            const chunkEnd = dataEnd + 2; // trailing CRLF after the chunk data

            if (chunkEnd > buffer.length) {
                break drain; // Need more data bytes.
            }

            // The two bytes after the chunk data must be the required CRLF.
            if (buffer[dataEnd] !== 0x0d || buffer[dataEnd + 1] !== 0x0a) {
                throw new ChunkEncodingError(consumed + dataEnd);
            }

            yield buffer.slice(dataStart, dataEnd);
            consumed += chunkEnd;
            buffer = buffer.slice(chunkEnd);
        }
    }

    // Stream ended before the terminating zero chunk arrived.
    throw new ChunkEncodingError(consumed);
}

/** Decode a slice of bytes as ASCII without going through `Buffer`. */
function decodeAscii(buf: Uint8Array, start: number, end: number): string {
    let out = "";
    for (let i = start; i < end; i++) {
        const byte = buf[i];
        if (byte === undefined) {
            throw new Error("decodeAscii: index out of bounds");
        }
        out += String.fromCodePoint(byte);
    }
    return out;
}
