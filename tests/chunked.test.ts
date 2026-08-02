import { describe, expect, it } from "vitest";
import { parseChunkedEncoding } from "../src/message.js";
import { ChunkEncodingError } from "../src/errors.js";

/** Build an async iterable that yields the given byte buffers in order. */
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
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

describe("parseChunkedEncoding", () => {
    it("decodes a multi-chunk body into concatenated bytes", async () => {
        // "Hello" (5) then " world" (6), then the terminating zero chunk.
        const full = `5\r\nHello\r\n6\r\n world\r\n0\r\n\r\n`;
        const result = await materialize(
            parseChunkedEncoding(stream(encode(full))),
        );
        expect(decode(result)).toBe("Hello world");
    });

    it("handles trailers after the terminating zero chunk", async () => {
        const wire = `5\r\nHello\r\n0\r\nX-Trailer: value\r\n\r\n`;
        const result = await materialize(parseChunkedEncoding(stream(encode(wire))));
        expect(decode(result)).toBe("Hello");
    });

    it("ignores chunk extensions", async () => {
        const wire = `5;name=value;foo\r\nHello\r\n0\r\n\r\n`;
        const result = await materialize(parseChunkedEncoding(stream(encode(wire))));
        expect(decode(result)).toBe("Hello");
    });

    it("streams chunks as they arrive across multiple pushes", async () => {
        // Push byte-by-byte-ish: split the framing across several yields.
        const wire = `5\r\nHello\r\n0\r\n\r\n`;
        const bytes = encode(wire);
        // Yield one byte at a time.
        const result = await materialize(
            parseChunkedEncoding(stream(...Array.from(bytes, (b) => new Uint8Array([b])))),
        );
        expect(decode(result)).toBe("Hello");
    });

    it("throws ChunkEncodingError on a malformed size line", async () => {
        const wire = `ZZZ\r\nHello\r\n0\r\n\r\n`;
        await expect(
            materialize(parseChunkedEncoding(stream(encode(wire)))),
        ).rejects.toBeInstanceOf(ChunkEncodingError);
    });

    it("throws ChunkEncodingError when the stream is truncated mid-chunk", async () => {
        // Size says 10 but only 3 data bytes follow, then the stream ends.
        const wire = `a\r\nabc`;
        await expect(
            materialize(parseChunkedEncoding(stream(encode(wire)))),
        ).rejects.toBeInstanceOf(ChunkEncodingError);
    });

    it("throws ChunkEncodingError when the terminating CRLF is missing", async () => {
        // 3 bytes of data but no trailing CRLF before the next size line.
        const wire = `3\r\nabc0\r\n\r\n`;
        await expect(
            materialize(parseChunkedEncoding(stream(encode(wire)))),
        ).rejects.toBeInstanceOf(ChunkEncodingError);
    });

    it("reports the byte offset where the malformed chunk was detected", async () => {
        // Valid 2-byte chunk, then a bad size line. Offset points at the bad chunk.
        const wire = `2\r\nok\r\nZZZ\r\n`;
        try {
            await materialize(parseChunkedEncoding(stream(encode(wire))));
            expect.unreachable("should have thrown");
        } catch (err) {
            expect(err).toBeInstanceOf(ChunkEncodingError);
            // "2\r\nok\r\n" is 7 bytes; the bad size line starts at offset 7.
            expect((err as ChunkEncodingError).offset).toBe(7);
        }
    });
});
