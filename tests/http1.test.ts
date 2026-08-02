import { describe, expect, it } from "vitest";
import { HttpResponse } from "../src/types.js";
import { RedirectLimitError, InvalidResponseError, ChunkEncodingError } from "../src/errors.js";
import { serializeRequest, parseResponse } from "../src/message.js";

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
});

// Keep HttpResponse import used for the type annotation in the test above.
void (undefined as unknown as HttpResponse);
