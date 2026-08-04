/**
 * Small shared helpers for @browsercore/http1.
 *
 * Kept dependency-free so every package can copy the pattern without pulling in
 * cross-package imports.
 */

import type { Http1ConnectionId, Clock } from "./types.js";
import { systemClock } from "./types.js";

/**
 * Exhaustiveness check for `switch`/`if-else` over discriminated unions.
 * Call in the `default` branch: `default: assertNever(x)`.
 * Adding a new union member forces every handler to compile-error until handled.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function assertNever(x: never): never {
    throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}

/** Generate a branded HTTP/1.1 connection id. */
export function createId(prefix: string, clock: Clock = systemClock): Http1ConnectionId {
    return `${prefix}_${clock.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}` as Http1ConnectionId;
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
            throw new Error("decodeAscii: index out of bounds");
        }
        out += String.fromCodePoint(byte);
    }
    return out;
}
