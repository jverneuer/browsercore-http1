/**
 * Byte-level helpers for {@link Http1ConnectionImpl}.
 *
 * Pure scanning/decoding functions over raw response bytes — factored out of
 * `connection.ts` so the connection class stays focused on lifecycle and
 * request/response orchestration. None of these are exported; they are
 * consumed solely by the connection implementation.
 */

import type { Http1CloseReason } from "./types.js";
import { assertNever, decodeAscii, consumeTrailers } from "./utils.js";

/** Find the offset of the `\r\n\r\n` header terminator, or -1 if not present. */
export function findHeaderEnd(buf: Uint8Array): number {
    for (let i = 0; i + 3 < buf.length; i++) {
        if (
            buf[i] === 0x0d &&
            buf[i + 1] === 0x0a &&
            buf[i + 2] === 0x0d &&
            buf[i + 3] === 0x0a
        ) {
            return i;
        }
    }
    return -1;
}

/** Extract the `content-length` header value, or `undefined` if absent. */
export function extractContentLength(headerText: string): number | undefined {
    const match = /(?:^|\n)content-length:\s*(\d+)\r?/iu.exec(headerText);
    if (match === null) {
        return undefined;
    }
    const value = match[1];
    return value === undefined ? undefined : Number(value);
}

/** Whether the response uses chunked transfer-encoding. */
export function isChunkedEncoding(headerText: string): boolean {
    const match = /(?:^|\n)transfer-encoding:\s*([^\r\n]+)/iu.exec(headerText);
    if (match === null) {
        return false;
    }
    const value = match[1];
    return value !== undefined && value.toLowerCase().includes("chunked");
}

/**
 * Find the offset just past the end of a chunked body in `buf`, starting the
 * scan at `bodyStart`. Returns -1 if the terminating chunk has not arrived.
 */
export function findChunkedBodyEnd(buf: Uint8Array, bodyStart: number): number {
    let offset = bodyStart;
    while (offset < buf.length) {
        // Find the end of the chunk-size line.
        let lineEnd = -1;
        for (let i = offset; i + 1 < buf.length; i++) {
            if (buf[i] === 0x0d && buf[i + 1] === 0x0a) {
                lineEnd = i;
                break;
            }
        }
        if (lineEnd === -1) {
            return -1;
        }

        const sizeLine = decodeAscii(buf, offset, lineEnd);
        // exec returns null (not undefined) when there is no match.
        if (!/^[0-9a-fA-F]+(?:;[^\r\n]*)?$/u.test(sizeLine)) {
            return -1;
        }

        const size = Number.parseInt(sizeLine, 16);
        const dataStart = lineEnd + 2;

        if (size === 0) {
            // last-chunk = "1*("0") [ chunk-ext ] CRLF" — no chunk-data, no
            // trailing data CRLF. dataStart points just past the "0\r\n".
            // trailer-part follows: zero or more header-field lines, then a
            // final blank line. consumeTrailers returns the offset just past
            // that final blank line, or -1 if the buffer doesn't hold it all.
            const trailerEnd = consumeTrailers(buf, dataStart);
            return trailerEnd === -1 ? -1 : trailerEnd;
        }

        const dataEnd = dataStart + size;
        const chunkEnd = dataEnd + 2; // trailing \r\n after chunk data

        if (chunkEnd > buf.length) {
            return -1;
        }
        if (buf[dataEnd] !== 0x0d || buf[dataEnd + 1] !== 0x0a) {
            return -1;
        }

        offset = chunkEnd;
    }
    return -1;
}

/** Human-readable description of a close reason — for error messages. */
export function describeCloseReason(reason: Http1CloseReason): string {
    switch (reason.kind) {
        case "client_close":
            return "client closed";
        case "remote_close":
            return "remote closed";
        case "error":
            return `error: ${reason.error.message}`;
        case "redirect_jump":
            return `redirect to ${reason.to}`;
        default:
            return assertNever(reason);
    }
}

/** Yield the bytes of a single buffer as an `AsyncIterable` (one chunk). */
export function chunkIterable(buf: Uint8Array): AsyncIterable<Uint8Array> {
    let yielded = false;
    return {
        [Symbol.asyncIterator]() {
            return {
                next(): Promise<IteratorResult<Uint8Array>> {
                    if (buf.length === 0 || yielded) {
                        return Promise.resolve({ value: undefined, done: true });
                    }
                    yielded = true;
                    return Promise.resolve({ value: buf, done: false });
                },
            };
        },
    };
}

/** Collect all chunks of an async byte stream into one contiguous buffer. */
export async function materialize(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream) {
        chunks.push(chunk);
        total += chunk.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

/** Collect all `set-cookie` header values (case-insensitive) in wire order. */
export function collectSetCookie(headers: ReadonlyMap<string, string>): string[] {
    const out: string[] = [];
    for (const [name, value] of headers) {
        if (name === "set-cookie") {
            out.push(value);
        }
    }
    return out;
}
