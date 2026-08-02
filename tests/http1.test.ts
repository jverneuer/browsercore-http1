import { describe, expect, it } from "vitest";
import { HttpResponse } from "../src/types.js";
import {
    Http1Error,
    RedirectLimitError,
    InvalidResponseError,
    ContentEncodingError,
    ChunkEncodingError,
} from "../src/errors.js";
import { serializeRequest, parseResponse } from "../src/message.js";
import type { HttpBodyKind } from "../src/types.js";
import { assertNever } from "../src/utils.js";

describe("serializeRequest", () => {
    it("serializes a simple GET request with no headers or body", () => {
        const req = {
            method: "GET" as const,
            url: "/index.html",
            headers: new Map<string, string>(),
            body: { kind: "empty" as const },
        };
        const bytes = serializeRequest(req);
        const text = new TextDecoder().decode(bytes);
        // RFC 7230: request-line CRLF, then headers (none here), then the blank
        // line that terminates the header section. No body → no further bytes.
        expect(text).toBe("GET /index.html HTTP/1.1\r\n\r\n");
    });

    it("serializes headers and respects body bytes", () => {
        const headers = new Map<string, string>([
            ["host", "example.com"],
            ["accept", "text/html"],
        ]);
        const req = {
            method: "POST" as const,
            url: "/submit",
            headers,
            body: { kind: "bytes" as const, data: new TextEncoder().encode("hello") },
        };
        const bytes = serializeRequest(req);
        const text = new TextDecoder().decode(bytes);
        expect(text).toContain("POST /submit HTTP/1.1\r\n");
        expect(text).toContain("host: example.com\r\n");
        expect(text).toContain("accept: text/html\r\n");
        // Body bytes follow the blank line.
        expect(bytes.slice(bytes.length - 5)).toEqual(new TextEncoder().encode("hello"));
    });
});

describe("parseResponse", () => {
    it("parses a raw HTTP response string into an HttpResponse", () => {
        const raw = "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 5\r\n\r\nhello";
        const buf = new TextEncoder().encode(raw);
        const { response, bytesConsumed } = parseResponse(buf);
        expect(response).toEqual({
            statusCode: 200,
            statusText: "OK",
            headers: new Map([
                ["content-type", "text/plain"],
                ["content-length", "5"],
            ]),
            body: new TextEncoder().encode("hello"),
        });
        expect(bytesConsumed).toBe(raw.length);
    });

    it("throws InvalidResponseError on garbage input", () => {
        const buf = new TextEncoder().encode("not an http response");
        expect(() => parseResponse(buf)).toThrow(InvalidResponseError);
    });
});

describe("error classes", () => {
    it("instantiates RedirectLimitError with trail", () => {
        const err = new RedirectLimitError(5, ["/a", "/b", "/c"]);
        expect(err.kind).toBe("RedirectLimitError");
        expect(err.limit).toBe(5);
        expect(err.trail).toEqual(["/a", "/b", "/c"]);
    });

    it("instantiates ChunkEncodingError with offset", () => {
        const err = new ChunkEncodingError(42);
        expect(err.kind).toBe("ChunkEncodingError");
        expect(err.offset).toBe(42);
    });

    it("Http1Error base class carries kind, message and cause", () => {
        const cause = new Error("root cause");
        const err = new Http1Error("something broke", { cause });
        expect(err).toBeInstanceOf(Error);
        expect(err.kind).toBe("Http1Error");
        expect(err.message).toBe("something broke");
        expect(err.name).toBe("Http1Error");
        expect(err.cause).toBe(cause);
    });

    it("subclasses accept an optional cause and expose it", () => {
        const cause = new Error("underlying");
        const redirect = new RedirectLimitError(3, ["/x"], { cause });
        expect(redirect.cause).toBe(cause);
        const invalid = new InvalidResponseError("garbage", { cause });
        expect(invalid.cause).toBe(cause);
        const encoding = new ContentEncodingError("zstd", { cause });
        expect(encoding.cause).toBe(cause);
        const chunked = new ChunkEncodingError(7, { cause });
        expect(chunked.cause).toBe(cause);
    });
});

describe("parseResponse edge cases", () => {
    it("throws InvalidResponseError when the status line is not HTTP", () => {
        // Header terminator present but the start line is garbage.
        const buf = new TextEncoder().encode("not http at all\r\n\r\n");
        expect(() => parseResponse(buf)).toThrow(InvalidResponseError);
    });

    it("throws InvalidResponseError when the status code is out of range", () => {
        // "050" parses to 50, below the valid 100-999 range.
        const buf = new TextEncoder().encode("HTTP/1.1 050 Low\r\n\r\n");
        expect(() => parseResponse(buf)).toThrow(InvalidResponseError);
    });

    it("returns the body verbatim when there is no content-length or transfer-encoding", () => {
        const raw = "HTTP/1.1 200 OK\r\n\r\nhello";
        const { response, bytesConsumed } = parseResponse(new TextEncoder().encode(raw));
        expect(response.statusCode).toBe(200);
        expect(new TextDecoder().decode(response.body)).toBe("hello");
        expect(bytesConsumed).toBe(raw.length);
    });
});

describe("assertNever", () => {
    it("throws for any value it is (impossible-ly) handed", () => {
        // assertNever is typed `never` — the only way to call it is a cast, which
        // is exactly the situation it guards against at runtime.
        expect(() => assertNever("surprise" as never)).toThrow(/Unexpected value/);
    });

    it("is the exhaustiveness guard for serializeRequest's body-kind switch", () => {
        // A body kind that is not empty/bytes must hit the default branch rather
        // than silently producing a malformed request.
        const req = {
            method: "GET" as const,
            url: "/",
            headers: new Map<string, string>(),
            body: { kind: "bogus" } as unknown as HttpBodyKind,
        };
        expect(() => serializeRequest(req)).toThrow(/Unexpected value/);
    });
});

// Keep HttpResponse import used for the type annotation in the test above.
void (undefined as unknown as HttpResponse);
