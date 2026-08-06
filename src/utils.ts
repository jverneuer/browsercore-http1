/**
 * Small shared helpers for @browsercore/http1.
 *
 * Kept dependency-free so every package can copy the pattern without pulling in
 * cross-package imports.
 */

import { systemClock, type Http1ConnectionId, type Clock, type RandomSource } from "./types.js";
import { DecodeError } from "./errors.js";
import { nodeRandomSource } from "@browsercore/transport";

export { nodeRandomSource };

/**
 * Exhaustiveness check for `switch`/`if-else` over discriminated unions.
 * Call in the `default` branch: `default: assertNever(x)`.
 * Adding a new union member forces every handler to compile-error until handled.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function assertNever(x: never): never {
    throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}

/**
 * Generate a branded HTTP/1.1 connection id.
 *
 * The trailing segment is drawn from `random` so the id is unique without
 * relying on `Math.random()`. This is the single sanctioned home for
 * randomness in http1 — other modules must call this rather than reaching for
 * randomness directly.
 */
export function createId(
    prefix: string,
    random: RandomSource,
    clock: Clock = systemClock,
): Http1ConnectionId {
    // 3 bytes → 24 bits of entropy, plenty for a ~1e6-space suffix.
    const bytes = random.randomBytes(3);
    const hi = bytes[0] ?? 0;
    const mid = bytes[1] ?? 0;
    const lo = bytes[2] ?? 0;
    const suffix = ((hi << 16) | (mid << 8) | lo) % 1_000_000;
    return `${prefix}_${clock.now().toString(36)}_${suffix.toString(36)}` as Http1ConnectionId;
}

/**
 * Explicit handle for a promise that is resolved/rejected from the outside.
 *
 * Replaces repeated `new Promise((resolve) => { ... })` waiter boilerplate: the
 * deferred's `resolve`/`reject` are exposed so an unrelated event can settle the
 * promise. Type-safe — the settled value is fixed at construction.
 */
export interface Deferred<T> {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
    readonly reject: (reason?: unknown) => void;
}

/** Create a {@link Deferred} whose `resolve`/`reject` can be invoked elsewhere. */
export function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/**
 * Consume the trailer section (zero or more header-field lines + a final blank
 * line) starting at `start`. Returns the offset just past the terminating blank
 * line, or -1 if the buffer does not yet hold the full trailer section.
 *
 * A blank line is a `CRLF` at `lineStart` — two consecutive `CRLF`s with no
 * header content between them. Shared by the chunked decoder and the
 * connection's chunked body scanner, which both need to find the end of a
 * trailer-part after the terminating zero chunk.
 */
export function consumeTrailers(buf: Uint8Array, start: number): number {
    let lineStart = start;
    for (let i = start; i + 1 < buf.length; i++) {
        if (buf[i] !== 0x0d || buf[i + 1] !== 0x0a) {
            continue;
        }
        if (i === lineStart) {
            return i + 2; // blank line — end of trailers
        }
        lineStart = i + 2;
    }
    return -1;
}

/**
 * Decode a slice of bytes as ASCII without going through `Buffer`.
 *
 * Indexes are bounds-checked explicitly rather than relying on `Uint8Array`
 * returning `undefined` out of range, so a corrupt offset surfaces as a clear
 * error instead of silent truncation.
 */
export function decodeAscii(buf: Uint8Array, start: number, end: number): string {
    let out = "";
    for (let i = start; i < end; i++) {
        const byte = buf[i];
        if (byte === undefined) {
            throw new DecodeError(i);
        }
        out += String.fromCodePoint(byte);
    }
    return out;
}
