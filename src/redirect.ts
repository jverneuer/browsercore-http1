/**
 * HTTP redirect following — protocol-level capability for @browsercore/http1.
 *
 * Design note: this logic is intentionally a STANDABLE exported function and is
 * NOT wired into {@link Http1ConnectionImpl.request}. The @browsercore/fetch
 * package implements its own redirect following (and connection-pool migration
 * across origins) in `src/client.ts`. Auto-following here would double-follow
 * against fetch. Instead, `followRedirects` gives a clean, tested capability
 * that fetch (or any caller) can reuse, without changing current fetch behavior.
 *
 * Method/body rewrite follows RFC 7231:
 *   - 303 See Other   -> GET, body stripped.
 *   - 307/308         -> method + body preserved.
 *   - 301/302          -> method + body preserved (RFC-correct; browsers
 *                         historically GET-ify, but the spec does not).
 */

import type { Http1Connection, HttpRequest, HttpResponse } from "./types.js";
import { RedirectLimitError } from "./errors.js";

/** Status codes that trigger redirect handling. */
export const REDIRECT_STATUS_CODES = [301, 302, 303, 307, 308] as const;

/** Redirect status code union — exhaustive over REDIRECT_STATUS_CODES. */
export type RedirectStatusCode = (typeof REDIRECT_STATUS_CODES)[number];

/** Options for {@link followRedirects}. */
export interface FollowRedirectsOptions {
    /** Maximum number of redirects to follow before raising. Default 20. */
    readonly maxRedirects?: number;
}

/** Whether `status` is one of the redirect-triggering status codes. */
export function isRedirectStatus(status: number): status is RedirectStatusCode {
    return (REDIRECT_STATUS_CODES as readonly number[]).includes(status);
}

/**
 * Resolve a possibly-relative `Location` header against the current absolute
 * URL. A Location with its own scheme is returned as-is.
 */
export function resolveRedirectUrl(currentUrl: string, location: string): string {
    return new URL(location, currentUrl).toString();
}

/** Project an absolute URL back onto the wire request target (path + query). */
function requestTarget(url: string): string {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
}

/**
 * Build the request for the next hop of a redirect, rewriting method/body and
 * the `host` header per the status code.
 */
function buildRedirectRequest(req: HttpRequest, status: number, nextUrl: string): HttpRequest {
    const headers = new Map([...req.headers, ["host", new URL(nextUrl).host]]);
    if (status === 303) {
        // See Other: drop the body and any body-framing headers, switch to GET.
        headers.delete("content-length");
        headers.delete("transfer-encoding");
        headers.delete("content-type");
        return {
            method: "GET",
            url: requestTarget(nextUrl),
            headers,
            body: { kind: "empty" },
        };
    }
    return {
        ...req,
        url: requestTarget(nextUrl),
        headers,
    };
}

/**
 * Follow redirects for a request, returning the final response.
 *
 * The first request is dispatched as given; each redirect response is resolved
 * against the URL of the request that produced it. The chain stops at the
 * first non-redirect response, a redirect with no `Location`, or when the
 * limit / a loop is detected.
 *
 * @param conn  The connection to dispatch each hop on (same-origin redirects).
 * @param req   The initial request (carries the request target in `url`).
 * @param currentUrl  The absolute URL `req` was sent to — needed because
 *              `HttpRequest.url` is only the request target, not a full URL.
 * @throws {RedirectLimitError} on exceeding `maxRedirects` or a repeated URL.
 */
export async function followRedirects(
    conn: Http1Connection,
    req: HttpRequest,
    currentUrl: string,
    options: FollowRedirectsOptions = {},
): Promise<HttpResponse> {
    const maxRedirects = options.maxRedirects ?? 20;
    // trail[0] is the starting URL; each followed URL is appended. Used both
    // for loop detection and as the debug trail in the error.
    const trail: string[] = [currentUrl];
    let url = currentUrl;
    let request: HttpRequest = req;
    let response = await conn.request(request);

    while (isRedirectStatus(response.statusCode)) {
        // We've followed `trail.length - 1` redirects so far. Following one
        // more would exceed the limit.
        if (trail.length > maxRedirects) {
            throw new RedirectLimitError(maxRedirects, trail);
        }
        const location = response.headers.get("location");
        if (location === undefined) {
            // No Location header — nothing to follow. Return as-is.
            return response;
        }
        const nextUrl = resolveRedirectUrl(url, location);
        // Loop detection: a URL we've already visited.
        if (trail.includes(nextUrl)) {
            throw new RedirectLimitError(maxRedirects, [...trail, nextUrl]);
        }
        trail.push(nextUrl);
        url = nextUrl;
        request = buildRedirectRequest(request, response.statusCode, url);
        response = await conn.request(request);
    }

    return response;
}
