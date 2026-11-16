/**
 * Domain types for @browsercore/http1.
 *
 * HTTP/1.1 client over any duplex byte stream. This package owns NO knowledge
 * of TLS, TCP, or DNS — it composes exclusively over `@browsercore/transport`.
 */

import type { RandomSource, Transport } from "@browsercore/transport";
import type { DecompressionProvider } from "./decompress.js";

// Re-export RandomSource so internal modules can import it from ./types.js
// without each reaching for the transport package directly.
export type { RandomSource };

/** Branded HTTP/1.1 connection identifier. */
export type Http1ConnectionId = string & { __brand: "Http1ConnectionId" };

/** HTTP methods this client supports. Literal union — never bare `string`. */
export type HttpMethod =
    | "GET"
    | "POST"
    | "PUT"
    | "DELETE"
    | "PATCH"
    | "HEAD"
    | "OPTIONS"
    | "TRACE"
    | "CONNECT";

/**
 * What kind of body a request carries — makes the absent body unrepresentable.
 *
 * Streaming request bodies are not implemented (no PLAN step); the union is
 * closed at `empty` | `bytes`. The `default: assertNever` guard in
 * `serializeRequest` keeps this honest — adding a variant forces a compile error
 * until handled.
 */
export type HttpBodyKind =
    | { readonly kind: "empty" }
    | { readonly kind: "bytes"; readonly data: Uint8Array };

/**
 * How header field names are cased when serialized to the wire by
 * {@link serializeRequest}.
 *
 * - `lowercase` — RFC 7230 §3.2 convention; matches `node:http` (default).
 * - `title` — first letter capitalized, rest lowercased. Real browsers send
 *   mixed-case header names over HTTP/1.1 (e.g. `Content-Type`, `User-Agent`);
 *   this mode reproduces that for impersonation.
 * - `original` — names emitted verbatim, exactly as stored by the caller.
 */
export type HeaderCasing = "lowercase" | "title" | "original";

/** A fully-serializable HTTP/1.1 request. */
export interface HttpRequest {
    readonly method: HttpMethod;
    readonly url: string;
    /** Headers are stored as a ReadonlyMap (case-insensitive on the wire). */
    readonly headers: ReadonlyMap<string, string>;
    readonly body: HttpBodyKind;
    /**
     * Controls how header field names are cased on the wire. Defaults to
     * `lowercase` for backward compatibility when omitted.
     */
    readonly headerCasing?: HeaderCasing;
}

/** A single parsed header pair, in wire order (no framing detail). */
export interface ParsedHeaderPair {
    readonly name: string;
    readonly value: string;
}

/**
 * Parsed HTTP/1.1 headers — the container handed to consumers after
 * `parseResponse` (`HttpResponse.headers`).
 *
 * Two views over the SAME wire data:
 *
 * - **Flat record (backward compatible):** the container IS a
 *   `ReadonlyMap<string, string>`. Its view keeps one entry per field name
 *   and is LAST-WINS for repeated fields — `get()`/`entries()` return only
 *   the last value a field carried. This is the historic behaviour, kept
 *   exactly for compatibility; consumers that only see the flat record never
 *   observe the earlier values (issue #43: multi-`Set-Cookie` fidelity was
 *   impossible above this layer).
 * - **Multi-value fidelity:** {@link ParsedHeaders.getHeaderValues} returns
 *   EVERY value a field carried, in wire order — each header line's value
 *   verbatim as a separate entry, NOT comma-joined. `Set-Cookie` must never
 *   be pre-joined: its values routinely contain dates and other commas
 *   (RFC 6265bis requires recipients to handle each Set-Cookie field
 *   individually), so folding would corrupt the data. Per RFC 9110 §5.2/§5.3
 *   field order and multiplicity are semantically meaningful for several
 *   fields.
 *
 * Field names are case-insensitive (RFC 9110 §5.1); the parser lowercases
 * them, so lookups through either view are case-insensitive.
 */
export interface ParsedHeaders extends ReadonlyMap<string, string> {
    /**
     * All values for a field, in wire order. Empty array if the field is
     * absent.
     *
     * Lookup matches the field name case-insensitively (HTTP field names are
     * case-insensitive, RFC 9110 §5.1); the HTTP/1.1 parser lowercases names,
     * so passing the lowercase name is the norm.
     */
    getHeaderValues(name: string): readonly string[];
}

/**
 * The immutable {@link ParsedHeaders} implementation `parseResponse`
 * assembles.
 *
 * The ordered pair list is the fidelity source, threaded from the parser
 * WITHOUT deduplication; the flat record is derived from it (last-wins via
 * `Map.set`). One object, both views — no divergence is possible.
 */
export class ParsedHeadersImpl implements ParsedHeaders {
    /** Every parsed pair, in wire order — duplicates preserved. */
    private readonly orderedPairs: readonly ParsedHeaderPair[];
    /** Derived flat record: last-wins per name, first-occurrence iteration order. */
    private readonly flat: ReadonlyMap<string, string>;

    constructor(pairs: readonly ParsedHeaderPair[]) {
        this.orderedPairs = pairs;
        this.flat = new Map(pairs.map((pair) => [pair.name, pair.value] as const));
    }

    /** @inheritdoc */
    public getHeaderValues(name: string): readonly string[] {
        const needle = name.toLowerCase();
        const values: string[] = [];
        for (const pair of this.orderedPairs) {
            if (pair.name.toLowerCase() === needle) {
                values.push(pair.value);
            }
        }
        return values;
    }

    /** @inheritdoc */
    public get(key: string): string | undefined {
        return this.flat.get(key);
    }

    /** @inheritdoc */
    public has(key: string): boolean {
        return this.flat.has(key);
    }

    /** @inheritdoc */
    public get size(): number {
        return this.flat.size;
    }

    /** @inheritdoc */
    public keys(): MapIterator<string> {
        return this.flat.keys();
    }

    /** @inheritdoc */
    public values(): MapIterator<string> {
        return this.flat.values();
    }

    /** @inheritdoc */
    public entries(): MapIterator<[string, string]> {
        return this.flat.entries();
    }

    /** @inheritdoc */
    public [Symbol.iterator](): MapIterator<[string, string]> {
        return this.flat[Symbol.iterator]();
    }

    /** @inheritdoc */
    public forEach(
        callback: (value: string, key: string, map: ReadonlyMap<string, string>) => void,
        thisArg?: unknown,
    ): void {
        this.flat.forEach(callback, thisArg);
    }
}

/** A parsed HTTP/1.1 response. */
export interface HttpResponse {
    readonly statusCode: number;
    readonly statusText: string;
    /**
     * Parsed response headers. Flat view is LAST-WINS for repeated fields
     * (backward compatible); `getHeaderValues(name)` returns every value in
     * wire order — see {@link ParsedHeaders}.
     */
    readonly headers: ParsedHeaders;
    readonly body: Uint8Array;
}

/** Why an HTTP/1.1 connection was closed. */
export type Http1CloseReason =
    | { readonly kind: "client_close" }
    | { readonly kind: "remote_close" }
    | { readonly kind: "error"; readonly error: Error }
    | { readonly kind: "redirect_jump"; readonly to: string };

/** Lifecycle state of an HTTP/1.1 connection. */
export type Http1ConnectionState =
    | { readonly state: "idle" }
    | { readonly state: "in_flight"; readonly pending: number }
    | { readonly state: "closing" }
    | { readonly state: "closed"; readonly reason: Http1CloseReason };

/** Public contract for an HTTP/1.1 connection. */
export interface Http1Connection {
    /** Opaque identifier for logging / correlation. */
    readonly id: Http1ConnectionId;
    /** Current lifecycle state. */
    readonly state: Http1ConnectionState;

    /**
     * Send a request and await the full response. Resolves when the response
     * headers + body have been read and decoded (per content-encoding).
     */
    request(req: HttpRequest): Promise<HttpResponse>;

    /** Gracefully close the connection. Resolves once no requests are in flight. */
    close(reason?: Http1CloseReason): Promise<void>;
}

// ---------------------------------------------------------------------------
// Clock abstraction (injected — decouples protocol code from `Date.now()`)
// ---------------------------------------------------------------------------

/**
 * Clock for time-dependent operations. Injected via {@link Http1Options} so
 * callers control the time source — keeps the package testable against a
 * deterministic clock (reproducible id generation) and embeddable in non-Node
 * hosts (browsers, workers) where `Date.now()` may not be the desired source.
 *
 * `now()` MUST return milliseconds since the Unix epoch, matching the contract
 * of `Date.now()`.
 */
export interface Clock {
    /** Current time in milliseconds since the Unix epoch. */
    now(): number;
}

/** The default clock — delegates to the platform `Date.now()`. */
export const systemClock: Clock = {
    now: () => Date.now(),
};

/**
 * Cookie-jar integration seam.
 *
 * http1 does NOT own cookie storage — the @browsercore/fetch cookie jar does. This
 * interface is the seam: a caller that wants cookies injected / collected
 * supplies an implementation. When absent, requests pass through unchanged.
 *
 * `addCookies` returns either a full header map to merge in, or a single
 * `Cookie` header value as a bare string.
 */
export interface CookieInterceptor {
    /** Return headers to inject (e.g. `Cookie`) for the given request URL. */
    readonly addCookies?: (url: CookieUrl) => Map<string, string> | string;
    /** Store any `Set-Cookie` headers received for the given response URL. */
    readonly storeCookies?: (url: CookieUrl, setCookieHeaders: string[]) => void;
}

/** The subset of URL info a cookie interceptor needs to match/store. */
export interface CookieUrl {
    /** Host (no port) to match cookies against. */
    readonly host: string;
    /** Path to match cookies against. */
    readonly path: string;
    /** Protocol, e.g. `"http:"` or `"https:"`. */
    readonly protocol: string;
}

/** Options for {@link connectHttp1}. */
export interface Http1Options {
    /** The underlying byte-stream transport (already connected). */
    readonly transport: Transport;
    /**
     * Maximum redirects to follow before raising {@link RedirectLimitError}.
     * Default 10. Note: http1 does NOT auto-follow redirects — this is consumed
     * by the standalone {@link followRedirects} helper. See src/redirect.ts.
     */
    readonly maxRedirects?: number;
    /**
     * Whether to follow 3xx redirects at all. Default true. Note: http1 does
     * NOT auto-follow redirects — this is consumed by the standalone
     * {@link followRedirects} helper. See src/redirect.ts.
     */
    readonly followRedirects?: boolean;
    /** Override the default headers encoder (for testing / exotic encodings). */
    readonly headersEncoder?: "ascii" | "utf8";
    /**
     * Optional cookie-jar seam. When present, `addCookies` is called before
     * serializing each request and `storeCookies` after parsing each response.
     * http1 performs no cookie storage of its own.
     */
    readonly cookieInterceptor?: CookieInterceptor;
    /**
     * Content-encoding decompression backend. http1 does NOT own a zlib
     * provider — it depends only on the {@link DecompressionProvider}
     * interface, never on a concrete implementation. The @browsercore/fetch
     * layer injects its `@browsercore/compression` singleton here.
     *
     * When absent and a response carries a `content-encoding`, the connection
     * raises {@link ContentEncodingError} rather than returning corrupt bytes.
     */
    readonly decompressionProvider?: DecompressionProvider;
    /**
     * Clock for time-dependent operations. Defaults to {@link systemClock}
     * (delegates to `Date.now()`). Inject a deterministic clock for
     * reproducible ids in tests.
     */
    readonly clock?: Clock;
    /**
     * Source of cryptographically-strong random bytes. Used for connection IDs
     * and any other randomness needs. Defaults to `nodeRandomSource` (a
     * `node:crypto.randomBytes`-backed source) when not provided.
     */
    readonly random?: RandomSource;
}
