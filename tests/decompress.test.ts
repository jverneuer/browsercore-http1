import { describe, expect, it } from "vitest";
import { gzipSync, deflateSync, deflateRawSync, brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { decompressBody } from "../src/decompress.js";
import { ContentEncodingError } from "../src/errors.js";

const payload = "the quick brown fox jumps over the lazy dog.".repeat(16);

function enc(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

describe("decompressBody", () => {
    it("decodes gzip", () => {
        const compressed = new Uint8Array(gzipSync(enc(payload)));
        expect(new TextDecoder().decode(decompressBody(compressed, "gzip"))).toBe(payload);
    });

    it("decodes x-gzip", () => {
        const compressed = new Uint8Array(gzipSync(enc(payload)));
        expect(new TextDecoder().decode(decompressBody(compressed, "x-gzip"))).toBe(payload);
    });

    it("decodes deflate (zlib-wrapped)", () => {
        const compressed = new Uint8Array(deflateSync(enc(payload)));
        expect(new TextDecoder().decode(decompressBody(compressed, "deflate"))).toBe(payload);
    });

    it("decodes raw deflate (no zlib header)", () => {
        const compressed = new Uint8Array(deflateRawSync(enc(payload)));
        expect(new TextDecoder().decode(decompressBody(compressed, "deflate"))).toBe(payload);
    });

    it("decodes brotli", () => {
        const compressed = new Uint8Array(brotliCompressSync(enc(payload)));
        // Sanity: our decoder is the inverse of brotliCompressSync. Compare as
        // strings since brotliDecompressSync returns a Buffer.
        expect(new TextDecoder().decode(brotliDecompressSync(compressed))).toBe(payload);
        expect(new TextDecoder().decode(decompressBody(compressed, "br"))).toBe(payload);
    });

    it("throws ContentEncodingError on unsupported encoding", () => {
        expect(() => decompressBody(enc(payload), "zstd")).toThrow(ContentEncodingError);
    });

    it("throws ContentEncodingError on corrupt gzip stream", () => {
        const garbage = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff, 0xff, 0xff]);
        expect(() => decompressBody(garbage, "gzip")).toThrow(ContentEncodingError);
    });

    it("carries the encoding name on the error", () => {
        try {
            decompressBody(enc(payload), "bzip2");
            expect.unreachable("should have thrown");
        } catch (err) {
            expect(err).toBeInstanceOf(ContentEncodingError);
            expect((err as ContentEncodingError).encoding).toBe("bzip2");
        }
    });
});
