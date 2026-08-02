/**
 * Domain types for @browsercore/http1.
 *
 * HTTP/1.1 client over any duplex byte stream. This package owns NO knowledge
 * of TLS, TCP, or DNS — it composes exclusively over `@browsercore/transport`.
 */

import type { Transport } from "@browsercore/transport";

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

/** A fully-serializable HTTP/1.1 request. */
export interface HttpRequest {
    readonly method: HttpMethod;
    readonly url: string;
    /** Headers are case-insensitive once serialized — stored as a ReadonlyMap. */
    readonly headers: ReadonlyMap<string, string>;
    readonly body: HttpBodyKind;
}

/** A parsed HTTP/1.1 response. */
export interface HttpResponse {
    readonly statusCode: number;
    readonly statusText: string;
    readonly headers: ReadonlyMap<string, string>;
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
}
