import { describe, expect, it } from "vitest";
import { serializeRequest, parseResponse, parseChunkedEncoding } from "../src/message.js";
import { InvalidResponseError, ChunkEncodingError } from "../src/errors.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Yield the given byte buffers in order as an async iterable. */
async function* stream(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
    for (const c of chunks) yield c;
}

/** Materialize an async byte stream into one contiguous buffer. */
async function materialize(s: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const c of s) {
        chunks.push(c);
        total += c.length;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.length;
    }
    return out;
}

describe("serializeRequest edge cases", () => {
    it("lowercases header names on the wire", () => {
        // RFC 7230 §3.2: header field names are case-insensitive; node:http
        // lowercases them. The serializer matches that convention so a server
        // sees canonical casing regardless of how the caller stored the name.
        const req = {
            method: "GET" as const,
            url: "/",
            headers: new Map([["HOST", "Example.com"], ["Accept", "*/*"]]),
            body: { kind: "empty" as const },
        };
        const text = dec(serializeRequest(req));
        expect(text).toContain("host: Example.com\r\n");
        expect(text).toContain("accept: */*\r\n");
        expect(text).not.toContain("HOST:");
    });

    it("appends body bytes verbatim after the header terminator", () => {
        // Binary body with non-text bytes — must be copied byte-for-byte.
        // (Hex escapes are used because octal escapes are invalid in ESM.)
        const data = enc("\x00binary\x01data");
        const req = {
            method: "PUT" as const,
            url: "/upload",
            headers: new Map([["content-length", String(data.length)]]),
            body: { kind: "bytes" as const, data },
        };
        const bytes = serializeRequest(req);
        expect(bytes.slice(bytes.length - data.length)).toEqual(data);
    });

    it("serializes a request target with a query string and no headers", () => {
        const req = {
            method: "GET" as const,
            url: "/search?q=hello&page=2",
            headers: new Map<string, string>(),
            body: { kind: "empty" as const },
        };
        expect(dec(serializeRequest(req))).toBe(
            "GET /search?q=hello&page=2 HTTP/1.1\r\n\r\n",
        );
    });
});

describe("parseResponse header parsing", () => {
    it("skips a malformed header line that has no colon", () => {
        // "garbage-line" has no colon and is silently skipped; the valid
        // content-length header is still parsed and the body is intact.
        const raw = "HTTP/1.1 200 OK\r\ngarbage-line\r\ncontent-length: 5\r\n\r\nhello";
        const { response, bytesConsumed } = parseResponse(enc(raw));
        expect(response.headers.get("content-length")).toBe("5");
        expect(response.headers.has("garbage-line")).toBe(false);
        expect(dec(response.body)).toBe("hello");
        expect(bytesConsumed).toBe(raw.length);
    });

    it("trims surrounding whitespace from header names and values", () => {
        const raw = "HTTP/1.1 200 OK\r\n  X-Spaced  :  token-value  \r\n\r\n";
        const { response } = parseResponse(enc(raw));
        expect(response.headers.get("x-spaced")).toBe("token-value");
    });

    it("lowercases header names", () => {
        const raw = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n";
        const { response } = parseResponse(enc(raw));
        expect(response.headers.get("content-type")).toBe("text/plain");
        expect(response.headers.has("Content-Type")).toBe(false);
    });

    it("keeps the last value for single-valued duplicate headers", () => {
        // Single-valued headers stay in a Map keyed on the lowercased name, so
        // later lines overwrite earlier. Set-Cookie is the one exception: it is
        // collected into a dedicated array (see the Set-Cookie tests below) so
        // RFC 6265 §3.1 multiple values are preserved.
        const raw = "HTTP/1.1 200 OK\r\nx-dup: one\r\nx-dup: two\r\n\r\n";
        const { response } = parseResponse(enc(raw));
        expect(response.headers.get("x-dup")).toBe("two");
    });

    it("preserves every Set-Cookie header (RFC 6265 §3.1)", () => {
        // Set-Cookie may legitimately repeat in a single response. Each line is
        // captured on the response's dedicated `setCookie` array in wire order,
        // so a cookie jar receives the full set rather than just the last value.
        const raw = "HTTP/1.1 200 OK\r\nset-cookie: a=1\r\nset-cookie: b=2\r\n\r\n";
        const { response } = parseResponse(enc(raw));
        expect(response.setCookie).toEqual(["a=1", "b=2"]);
        // The single-value Map retains the last value for fetch / generic
        // header consumers — no downstream shape change.
        expect(response.headers.get("set-cookie")).toBe("b=2");
    });

    it("captures all of three Set-Cookie headers", () => {
        const raw =
            "HTTP/1.1 200 OK\r\nset-cookie: sid=1\r\nset-cookie: theme=dark\r\nset-cookie: lang=en\r\n\r\n";
        const { response } = parseResponse(enc(raw));
        expect(response.setCookie).toEqual(["sid=1", "theme=dark", "lang=en"]);
    });

    it("exposes an empty setCookie array when there are no Set-Cookie headers", () => {
        const raw = "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\n";
        const { response } = parseResponse(enc(raw));
        expect(response.setCookie).toEqual([]);
    });

    it("returns the raw chunked body bytes without decoding", () => {
        // parseResponse is wire-format only; chunk decoding is the caller's job.
        const raw = "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n";
        const { response, bytesConsumed } = parseResponse(enc(raw));
        expect(dec(response.body)).toBe("5\r\nhello\r\n0\r\n\r\n");
        expect(bytesConsumed).toBe(raw.length);
    });

    it("returns the body verbatim when neither content-length nor chunked is set", () => {
        const raw = "HTTP/1.1 200 OK\r\n\r\nanything-at-all";
        const { response, bytesConsumed } = parseResponse(enc(raw));
        expect(dec(response.body)).toBe("anything-at-all");
        expect(bytesConsumed).toBe(raw.length);
    });

    it("parses a status line with empty status text", () => {
        // RFC 7231 allows a bare trailing space with no reason phrase.
        const raw = "HTTP/1.1 204 \r\n\r\n";
        const { response } = parseResponse(enc(raw));
        expect(response.statusCode).toBe(204);
        expect(response.statusText).toBe("");
    });

    it("parses a status line whose reason phrase contains spaces", () => {
        const raw = "HTTP/1.1 301 Moved Permanently\r\n\r\n";
        const { response } = parseResponse(enc(raw));
        expect(response.statusCode).toBe(301);
        expect(response.statusText).toBe("Moved Permanently");
    });

    it("throws InvalidResponseError when there is no header terminator", () => {
        expect(() => parseResponse(enc("HTTP/1.1 200 OK\r\ncontent-length: 5\r\n"))).toThrow(
            InvalidResponseError,
        );
    });

    it("throws InvalidResponseError at the low boundary of the status-code range", () => {
        // "099" parses to 99, just below the valid 100-999 range.
        expect(() => parseResponse(enc("HTTP/1.1 099 Low\r\n\r\n"))).toThrow(InvalidResponseError);
    });

    it("accepts the boundary status codes 100 and 999", () => {
        expect(parseResponse(enc("HTTP/1.1 100 Continue\r\n\r\n")).response.statusCode).toBe(100);
        expect(parseResponse(enc("HTTP/1.1 999 End\r\n\r\n")).response.statusCode).toBe(999);
    });

    it("exposes a rawPreview truncated to 120 chars on failure", () => {
        // A long garbage response is truncated in the error preview.
        const long = "X".repeat(200);
        try {
            parseResponse(enc(long));
            expect.unreachable("should have thrown");
        } catch (err) {
            expect(err).toBeInstanceOf(InvalidResponseError);
            expect((err as InvalidResponseError).rawPreview).toHaveLength(120);
        }
    });
});

describe("parseResponse content-length framing (RFC 7230 §3.3.2)", () => {
    // Centralized extraction is shared with the connection's framing logic
    // (extractContentLength). These cases pin that malformed / duplicate
    // content-length is rejected at BOTH sites rather than silently corrupting
    // the keep-alive buffer (NaN drain) or diverging first- vs last-wins.
    it("rejects a non-numeric content-length with InvalidResponseError", () => {
        // Previously `Number("abc")` → NaN → empty body slice → bytesConsumed
        // drained only the header, misaligning the next pipelined response.
        const raw = "HTTP/1.1 200 OK\r\ncontent-length: abc\r\n\r\nhello";
        expect(() => parseResponse(enc(raw))).toThrow(InvalidResponseError);
    });

    it("rejects duplicate content-length headers with InvalidResponseError", () => {
        // Previously the connection framed on the first (5) while parseResponse
        // drained on the last (6) — a one-byte misalignment that corrupts every
        // subsequent message on the connection.
        const raw = "HTTP/1.1 200 OK\r\ncontent-length: 5\r\ncontent-length: 6\r\n\r\nhello";
        expect(() => parseResponse(enc(raw))).toThrow(InvalidResponseError);
    });

    it("frames a single valid content-length exactly (regression guard)", () => {
        // Sanity check that legitimate content-length still frames precisely:
        // body sliced to the declared length, bytesConsumed drains it all.
        const raw = "HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello";
        const { response, bytesConsumed } = parseResponse(enc(raw));
        expect(dec(response.body)).toBe("hello");
        expect(bytesConsumed).toBe(raw.length);
    });
});

describe("parseChunkedEncoding edge cases", () => {
    it("ignores empty chunks pushed by the stream", async () => {
        // A streaming source may yield zero-length chunks (e.g. an empty read
        // frame). The decoder must skip them rather than mis-framing.
        const wire = "5\r\nhello\r\n0\r\n\r\n";
        const result = await materialize(
            parseChunkedEncoding(stream(enc(""), enc(wire), enc(""))),
        );
        expect(dec(result)).toBe("hello");
    });

    it("decodes an empty body (only the terminating zero chunk)", async () => {
        const result = await materialize(parseChunkedEncoding(stream(enc("0\r\n\r\n"))));
        expect(result).toEqual(new Uint8Array(0));
    });

    it("accepts an extension on the terminating zero chunk", async () => {
        const wire = "5\r\nhello\r\n0;name=done\r\n\r\n";
        const result = await materialize(parseChunkedEncoding(stream(enc(wire))));
        expect(dec(result)).toBe("hello");
    });

    it("decodes uppercase and mixed-case hex chunk sizes", async () => {
        // "A" = 10 decimal.
        const wire = "A\r\n0123456789\r\n0\r\n\r\n";
        const result = await materialize(parseChunkedEncoding(stream(enc(wire))));
        expect(dec(result)).toBe("0123456789");
    });

    it("reports offset 0 when the very first size line is malformed", async () => {
        const wire = "nope\r\nhello\r\n0\r\n\r\n";
        try {
            await materialize(parseChunkedEncoding(stream(enc(wire))));
            expect.unreachable("should have thrown");
        } catch (err) {
            expect(err).toBeInstanceOf(ChunkEncodingError);
            expect((err as ChunkEncodingError).offset).toBe(0);
        }
    });

    it("throws when the stream ends before any terminating zero chunk", async () => {
        // A single non-zero chunk with no zero-chunk terminator.
        await expect(
            materialize(parseChunkedEncoding(stream(enc("3\r\nabc\r\n")))),
        ).rejects.toBeInstanceOf(ChunkEncodingError);
    });
});
