import { describe, expect, it } from "vitest";
import type { Http1CloseReason } from "../src/types.js";
import {
    findHeaderEnd,
    extractContentLength,
    isChunkedEncoding,
    findChunkedBodyEnd,
    describeCloseReason,
    chunkIterable,
    materialize,
    collectSetCookie,
} from "../src/connection-helpers.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("findHeaderEnd", () => {
    it("locates the \\r\\n\\r\\n terminator offset", () => {
        // The terminator begins at the first \r of the "\r\n\r\n" run, which
        // sits right after the 15-byte status line "HTTP/1.1 200 OK".
        const buf = enc("HTTP/1.1 200 OK\r\n\r\n");
        expect(findHeaderEnd(buf)).toBe("HTTP/1.1 200 OK".length);
    });

    it("returns -1 when no terminator is present", () => {
        expect(findHeaderEnd(enc("HTTP/1.1 200 OK\r\ncontent-length: 5\r\n"))).toBe(-1);
    });

    it("returns -1 for a buffer too short to hold a terminator", () => {
        // Fewer than 4 bytes can never contain "\r\n\r\n".
        expect(findHeaderEnd(enc("ab"))).toBe(-1);
        expect(findHeaderEnd(new Uint8Array(0))).toBe(-1);
    });

    it("finds a terminator at the very start of the buffer", () => {
        // A bare blank line — empty headers section.
        expect(findHeaderEnd(enc("\r\n\r\n"))).toBe(0);
    });

    it("does not match a partial \\r\\n\\r sequence at the tail", () => {
        // Only three of the four terminator bytes are present at the end.
        expect(findHeaderEnd(enc("body\r\n\r"))).toBe(-1);
    });
});

describe("extractContentLength", () => {
    it("pulls the decimal value from a header section", () => {
        expect(extractContentLength("HTTP/1.1 200 OK\r\ncontent-length: 42\r\n")).toBe(42);
    });

    it("is case-insensitive on the header name", () => {
        expect(extractContentLength("HTTP/1.1 200 OK\r\nContent-Length: 7\r\n")).toBe(7);
    });

    it("returns undefined when the header is absent", () => {
        expect(extractContentLength("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n")).toBeUndefined();
    });

    it("returns undefined for a non-numeric value", () => {
        // The regex only matches digits — anything else is treated as absent
        // rather than producing NaN downstream.
        expect(extractContentLength("HTTP/1.1 200 OK\r\ncontent-length: abc\r\n")).toBeUndefined();
    });

    it("matches without a trailing CRLF (truncated header section)", () => {
        // The connection passes headerText sliced at the terminator offset, so
        // the final header often has no trailing \r\n. The \r? in the regex is
        // optional by design.
        expect(extractContentLength("HTTP/1.1 200 OK\r\ncontent-length: 11")).toBe(11);
    });
});

describe("isChunkedEncoding", () => {
    it("recognizes a bare chunked token", () => {
        expect(isChunkedEncoding("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n")).toBe(true);
    });

    it("recognizes chunked within a comma-separated list", () => {
        expect(isChunkedEncoding("HTTP/1.1 200 OK\r\ntransfer-encoding: gzip, chunked\r\n")).toBe(true);
    });

    it("is case-insensitive on the token", () => {
        expect(isChunkedEncoding("HTTP/1.1 200 OK\r\ntransfer-encoding: Chunked\r\n")).toBe(true);
    });

    it("returns false when the header is absent", () => {
        expect(isChunkedEncoding("HTTP/1.1 200 OK\r\ncontent-length: 5\r\n")).toBe(false);
    });

    it("returns false for an unrelated encoding", () => {
        expect(isChunkedEncoding("HTTP/1.1 200 OK\r\ntransfer-encoding: gzip\r\n")).toBe(false);
    });
});

describe("findChunkedBodyEnd", () => {
    it("locates the end of a complete single-chunk body", () => {
        const buf = enc("5\r\nhello\r\n0\r\n\r\n");
        expect(findChunkedBodyEnd(buf, 0)).toBe(buf.length);
    });

    it("locates the end of a multi-chunk body", () => {
        const buf = enc("2\r\nhi\r\n3\r\nyou\r\n0\r\n\r\n");
        expect(findChunkedBodyEnd(buf, 0)).toBe(buf.length);
    });

    it("locates the end when trailers follow the zero chunk", () => {
        const buf = enc("0\r\nx-trailer: v\r\n\r\n");
        expect(findChunkedBodyEnd(buf, 0)).toBe(buf.length);
    });

    it("returns -1 while the size line is incomplete (no CRLF yet)", () => {
        // Buffer holds only the hex digit, not the terminating CRLF — the
        // scanner can't even read the size line.
        expect(findChunkedBodyEnd(enc("5"), 0)).toBe(-1);
    });

    it("returns -1 for a non-hex size line", () => {
        expect(findChunkedBodyEnd(enc("ZZ\r\nhello\r\n0\r\n\r\n"), 0)).toBe(-1);
    });

    it("returns -1 when the chunk data has not fully arrived", () => {
        // Declared size 5 but only 3 data bytes and no trailing CRLF.
        expect(findChunkedBodyEnd(enc("5\r\nhel"), 0)).toBe(-1);
    });

    it("returns -1 when the trailing CRLF after chunk data is wrong", () => {
        // 5 bytes of data present but the next two bytes are not CRLF.
        expect(findChunkedBodyEnd(enc("5\r\nhelloXX"), 0)).toBe(-1);
    });

    it("returns -1 when the trailer section is incomplete", () => {
        // Zero chunk + a trailer line but no terminating blank line.
        expect(findChunkedBodyEnd(enc("0\r\nx-trailer: v"), 0)).toBe(-1);
    });

    it("returns -1 for an empty buffer", () => {
        expect(findChunkedBodyEnd(new Uint8Array(0), 0)).toBe(-1);
    });
});

describe("describeCloseReason", () => {
    it("describes each reason kind", () => {
        expect(describeCloseReason({ kind: "client_close" })).toBe("client closed");
        expect(describeCloseReason({ kind: "remote_close" })).toBe("remote closed");
        expect(describeCloseReason({ kind: "error", error: new Error("boom") })).toBe("error: boom");
        expect(describeCloseReason({ kind: "redirect_jump", to: "/new" })).toBe("redirect to /new");
    });

    it("asserts never for an unknown reason kind", () => {
        // The exhaustiveness guard fires if a new variant is added without
        // updating the switch.
        expect(() =>
            describeCloseReason({ kind: "bogus" } as unknown as Http1CloseReason),
        ).toThrow(/Unexpected value/);
    });
});

describe("chunkIterable", () => {
    it("yields the buffer once then signals done on the next call", async () => {
        const it = chunkIterable(enc("hi"))[Symbol.asyncIterator]();
        const first = await it.next();
        expect(first.done).toBe(false);
        expect(first.value).toEqual(enc("hi"));
        // Second call must report completion — a buffer is yielded at most once.
        const second = await it.next();
        expect(second.done).toBe(true);
    });

    it("immediately completes for an empty buffer", async () => {
        const it = chunkIterable(new Uint8Array(0))[Symbol.asyncIterator]();
        const first = await it.next();
        expect(first.done).toBe(true);
    });

    it("can be consumed via for-await-of exactly once", async () => {
        const out: Uint8Array[] = [];
        for await (const chunk of chunkIterable(enc("payload"))) {
            out.push(chunk);
        }
        expect(out).toEqual([enc("payload")]);
    });
});

describe("materialize", () => {
    it("concatenates chunks from a stream into one buffer", async () => {
        async function* src(): AsyncIterable<Uint8Array> {
            yield enc("foo");
            yield enc("bar");
        }
        const out = await materialize(src());
        expect(new TextDecoder().decode(out)).toBe("foobar");
    });

    it("returns an empty buffer for an empty stream", async () => {
        async function* empty(): AsyncIterable<Uint8Array> {
            // Yields nothing.
        }
        const out = await materialize(empty());
        expect(out).toEqual(new Uint8Array(0));
    });
});

describe("collectSetCookie", () => {
    // NOTE: parseResponse stores headers in a Map<string,string>, so duplicate
    // header field names collapse to their last value. In practice this means
    // collectSetCookie observes at most one "set-cookie" entry per response —
    // a real limitation for servers that send multiple Set-Cookie headers.
    it("collects a set-cookie value, skipping unrelated headers", () => {
        const headers = new Map<string, string>([
            ["content-type", "text/html"],
            ["set-cookie", "a=1"],
        ]);
        expect(collectSetCookie(headers)).toEqual(["a=1"]);
    });

    it("returns an empty array when there are no set-cookie headers", () => {
        const headers = new Map<string, string>([["content-type", "text/html"]]);
        expect(collectSetCookie(headers)).toEqual([]);
    });
});
