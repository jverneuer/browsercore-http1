/**
 * Regression gate for issue #43 — duplicate response headers collapse
 * last-wins.
 *
 * `parseResponse` built the header record as a flat `Map.set` loop, so a
 * response with multiple `Set-Cookie` headers (RFC 6265bis; legal and
 * extremely common — sessions, consent, A/B buckets) yielded only the LAST
 * cookie above this layer. The fix threads the full ordered [name, value]
 * pair list into `ParsedHeadersImpl` and derives the flat record from it:
 *
 *   - `getHeaderValues(name)` returns EVERY value in wire order, each header
 *     line's value verbatim — `Set-Cookie` is never comma-joined (its values
 *     contain dates with commas);
 *   - the flat record stays a `ReadonlyMap<string, string>` whose view is
 *     LAST-WINS per name (backward compatible);
 *   - the cookie seam (`storeCookies`) now receives every Set-Cookie value.
 *
 * Mirrors the contract http2 shipped in 0.2.12 (DecodedHeaders, PR #59) so
 * the layers stay symmetric.
 */

import { describe, expect, it } from "vitest";
import { parseResponse } from "../src/message.js";
import { connectHttp1 } from "../src/connection.js";
import { ParsedHeadersImpl } from "../src/types.js";
import type { ParsedHeaders } from "../src/types.js";
import { FakeTransportBase } from "./test-helpers.js";
import type { HttpRequest } from "../src/types.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * A fake in-memory transport that answers each write with a queued response.
 * Mirrors the harness in tests/cookie.test.ts.
 */
class FakeTransport extends FakeTransportBase {
    public readonly written: Uint8Array[] = [];
    private readonly responses: Uint8Array[] = [];

    public queueResponse(bytes: Uint8Array): void {
        this.responses.push(bytes);
    }

    public override async write(data: Uint8Array): Promise<void> {
        this.written.push(data);
        // Emit the next queued response asynchronously, like a real socket.
        const next = this.responses.shift();
        if (next !== undefined) {
            queueMicrotask(() => this.events.emit("data", next));
        }
    }
}

describe("ParsedHeadersImpl — flat record + multi-value fidelity", () => {
    it("returns every value for a repeated field in wire order", () => {
        const h = new ParsedHeadersImpl([
            { name: "set-cookie", value: "a=1" },
            { name: "x-single", value: "v" },
            { name: "set-cookie", value: "b=2" },
            { name: "set-cookie", value: "c=3" },
        ]);
        expect(h.getHeaderValues("set-cookie")).toEqual(["a=1", "b=2", "c=3"]);
        expect(h.getHeaderValues("x-single")).toEqual(["v"]);
        expect(h.getHeaderValues("x-absent")).toEqual([]);
    });

    it("matches field names case-insensitively (HTTP field names are case-insensitive)", () => {
        const h = new ParsedHeadersImpl([{ name: "set-cookie", value: "a=1" }]);
        expect(h.getHeaderValues("SET-COOKIE")).toEqual(["a=1"]);
        expect(h.getHeaderValues("Set-Cookie")).toEqual(["a=1"]);
    });

    it("never pre-joins values — a comma-bearing Expires date stays verbatim", () => {
        // Cookie values routinely contain dates with commas; folding the
        // header lines into one "value, value" string would corrupt them.
        const expires = "Expires=Wed, 21 Oct 2026 07:28:00 GMT";
        const h = new ParsedHeadersImpl([
            { name: "set-cookie", value: `session=abc; ${expires}` },
            { name: "set-cookie", value: "prefs=dark; Secure" },
        ]);
        expect(h.getHeaderValues("set-cookie")).toEqual([
            `session=abc; ${expires}`,
            "prefs=dark; Secure",
        ]);
        expect(h.getHeaderValues("set-cookie")).toHaveLength(2);
    });

    it("flat record stays last-wins per name (backward compatible)", () => {
        const h = new ParsedHeadersImpl([
            { name: "set-cookie", value: "a=1" },
            { name: "x-single", value: "v" },
            { name: "set-cookie", value: "b=2" },
        ]);
        expect(h.get("set-cookie")).toBe("b=2");
        expect(h.has("x-single")).toBe(true);
        expect(h.size).toBe(2); // deduped: repeated names collapse in the flat view
        expect([...h.entries()]).toEqual([
            ["set-cookie", "b=2"],
            ["x-single", "v"],
        ]);
    });

    it("empty block yields an empty container with no values", () => {
        const h = new ParsedHeadersImpl([]);
        expect(h.size).toBe(0);
        expect(h.getHeaderValues("x")).toEqual([]);
    });

    it("delegates the remaining ReadonlyMap surface to the flat record", () => {
        const h = new ParsedHeadersImpl([
            { name: "a", value: "1" },
            { name: "b", value: "2" },
        ]);
        const visited: Array<readonly [string, string]> = [];
        h.forEach((value, key, map) => {
            // The map argument is the container itself — a working ReadonlyMap.
            expect(map.get(key)).toBe(value);
            visited.push([key, value]);
        });
        expect(visited).toEqual([
            ["a", "1"],
            ["b", "2"],
        ]);
        expect([...h.values()]).toEqual(["1", "2"]);
        expect([...h.keys()]).toEqual(["a", "b"]);
        // Symbol.iterator — the container spreads like any ReadonlyMap.
        expect([...h]).toEqual([
            ["a", "1"],
            ["b", "2"],
        ]);
    });
});

describe("parseResponse preserves duplicate response fields (issue #43)", () => {
    it("getHeaderValues('set-cookie') returns both values in wire order, verbatim", () => {
        // Two Set-Cookie header lines — one carrying a comma-bearing Expires
        // date to prove values are never comma-joined.
        const raw =
            "HTTP/1.1 200 OK\r\n" +
            "content-type: text/html\r\n" +
            "set-cookie: session=abc; Path=/\r\n" +
            "set-cookie: prefs=dark; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure\r\n" +
            "\r\n";
        const { response } = parseResponse(enc(raw));
        expect(response.headers.getHeaderValues("set-cookie")).toEqual([
            "session=abc; Path=/",
            "prefs=dark; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure",
        ]);
    });

    it("preserves wire order across duplicates interleaved with other fields", () => {
        const raw =
            "HTTP/1.1 200 OK\r\n" +
            "x-a: 1\r\n" +
            "set-cookie: first=1\r\n" +
            "x-b: 2\r\n" +
            "set-cookie: second=2\r\n" +
            "set-cookie: third=3\r\n" +
            "content-length: 0\r\n" +
            "\r\n";
        const { response } = parseResponse(enc(raw));
        expect(response.headers.getHeaderValues("set-cookie")).toEqual([
            "first=1",
            "second=2",
            "third=3",
        ]);
        // Non-repeated fields are untouched in the flat view.
        expect(response.headers.get("x-a")).toBe("1");
        expect(response.headers.get("x-b")).toBe("2");
    });

    it("flat record still collapses to last-wins (backward compatibility)", () => {
        const raw = "HTTP/1.1 200 OK\r\nset-cookie: stale=0\r\nset-cookie: fresh=1\r\n\r\n";
        const { response } = parseResponse(enc(raw));
        // The flat ReadonlyMap view behaves exactly as before the fix.
        expect(response.headers.get("set-cookie")).toBe("fresh=1");
        expect([...response.headers.entries()].filter(([n]) => n === "set-cookie")).toEqual([
            ["set-cookie", "fresh=1"],
        ]);
        expect(response.headers.has("set-cookie")).toBe(true);
    });

    it("returns [] for absent fields and still resolves single-valued headers", () => {
        const raw = "HTTP/1.1 204 No Content\r\ncontent-type: text/plain\r\n\r\n";
        const { response } = parseResponse(enc(raw));
        expect(response.headers.getHeaderValues("set-cookie")).toEqual([]);
        expect(response.headers.get("content-type")).toBe("text/plain");
    });

    it("keeps bytesConsumed exact so keep-alive draining is unaffected", () => {
        // The pair list must not change the parse's byte accounting — the
        // connection slices its buffer by bytesConsumed for the next message.
        const first = "HTTP/1.1 200 OK\r\nset-cookie: a=1\r\nset-cookie: b=2\r\ncontent-length: 0\r\n\r\n";
        const second = "HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nhi";
        const buf = enc(`${first}${second}`);
        const firstParse = parseResponse(buf);
        expect(firstParse.bytesConsumed).toBe(first.length);
        const secondParse = parseResponse(buf.slice(firstParse.bytesConsumed));
        expect(secondParse.response.headers.getHeaderValues("set-cookie")).toEqual([]);
        expect(new TextDecoder().decode(secondParse.response.body)).toBe("hi");
    });
});

describe("cookie seam receives every Set-Cookie value (issue #43)", () => {
    it("storeCookies collects both values of a multi-Set-Cookie response", async () => {
        const transport = new FakeTransport();
        transport.queueResponse(
            enc(
                "HTTP/1.1 200 OK\r\n" +
                    "set-cookie: session=abc; Path=/\r\n" +
                    "set-cookie: csrf=tok; Secure\r\n" +
                    "content-length: 0\r\n" +
                    "\r\n",
            ),
        );
        const stored: string[] = [];
        const conn = await connectHttp1({
            transport,
            cookieInterceptor: {
                storeCookies: (_url, setCookies) => {
                    stored.push(...setCookies);
                },
            },
        });
        const req: HttpRequest = {
            method: "GET",
            url: "/login",
            headers: new Map([["host", "example.com"]]),
            body: { kind: "empty" },
        };
        await conn.request(req);
        await conn.close();
        expect(stored).toEqual(["session=abc; Path=/", "csrf=tok; Secure"]);
    });
});

describe("end-to-end: multi-Set-Cookie response over a real connection", () => {
    it("request() resolves with a headers container exposing both set-cookie values", async () => {
        const transport = new FakeTransport();
        transport.queueResponse(
            enc(
                "HTTP/1.1 200 OK\r\n" +
                    "set-cookie: session=abc; Path=/\r\n" +
                    "set-cookie: prefs=dark; Secure\r\n" +
                    "content-type: text/plain\r\n" +
                    "content-length: 2\r\n" +
                    "\r\n" +
                    "ok",
            ),
        );
        const conn = await connectHttp1({ transport });
        const req: HttpRequest = {
            method: "GET",
            url: "/",
            headers: new Map([["host", "example.com"]]),
            body: { kind: "empty" },
        };
        const res = await conn.request(req);

        expect(res.statusCode).toBe(200);
        expect(res.headers.getHeaderValues("set-cookie")).toEqual([
            "session=abc; Path=/",
            "prefs=dark; Secure",
        ]);
        // Flat view unaffected.
        expect(res.headers.get("set-cookie")).toBe("prefs=dark; Secure");
        expect(res.headers.get("content-type")).toBe("text/plain");
        expect(res.headers.getHeaderValues("x-absent")).toEqual([]);

        // The container satisfies the documented ParsedHeaders contract.
        const headers: ParsedHeaders = res.headers;
        expect(headers.getHeaderValues("set-cookie")).toHaveLength(2);

        await conn.close();
    });
});
