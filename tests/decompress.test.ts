import { describe, expect, it } from "vitest";
import { gzipSync, deflateSync, deflateRawSync, brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { compression } from "@browsercore/compression";
import type { DecompressionProvider } from "../src/decompress.js";
import { decompressBody, isSupportedContentEncoding } from "../src/decompress.js";
import { ContentEncodingError } from "../src/errors.js";

const payload = "the quick brown fox jumps over the lazy dog.".repeat(16);

function enc(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

describe("decompressBody", () => {
    it("decodes gzip", () => {
        const compressed = new Uint8Array(gzipSync(enc(payload)));
        expect(new TextDecoder().decode(decompressBody(compressed, "gzip", compression))).toBe(payload);
    });

    it("decodes x-gzip", () => {
        const compressed = new Uint8Array(gzipSync(enc(payload)));
        expect(new TextDecoder().decode(decompressBody(compressed, "x-gzip", compression))).toBe(payload);
    });

    it("decodes deflate (zlib-wrapped)", () => {
        const compressed = new Uint8Array(deflateSync(enc(payload)));
        expect(new TextDecoder().decode(decompressBody(compressed, "deflate", compression))).toBe(payload);
    });

    it("decodes raw deflate (no zlib header)", () => {
        const compressed = new Uint8Array(deflateRawSync(enc(payload)));
        expect(new TextDecoder().decode(decompressBody(compressed, "deflate", compression))).toBe(payload);
    });

    it("decodes brotli", () => {
        const compressed = new Uint8Array(brotliCompressSync(enc(payload)));
        // Sanity: our decoder is the inverse of brotliCompressSync. Compare as
        // strings since brotliDecompressSync returns a Buffer.
        expect(new TextDecoder().decode(brotliDecompressSync(compressed))).toBe(payload);
        expect(new TextDecoder().decode(decompressBody(compressed, "br", compression))).toBe(payload);
    });

    it("throws ContentEncodingError on unsupported encoding", () => {
        expect(() => decompressBody(enc(payload), "zstd", compression)).toThrow(ContentEncodingError);
    });

    it("throws ContentEncodingError on corrupt gzip stream", () => {
        const garbage = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff, 0xff, 0xff]);
        expect(() => decompressBody(garbage, "gzip", compression)).toThrow(ContentEncodingError);
    });

    it("carries the encoding name on the error", () => {
        try {
            decompressBody(enc(payload), "bzip2", compression);
            expect.unreachable("should have thrown");
        } catch (err) {
            expect(err).toBeInstanceOf(ContentEncodingError);
            expect((err as ContentEncodingError).encoding).toBe("bzip2");
        }
    });
});

describe("isSupportedContentEncoding", () => {
    it("accepts the encodings we decode", () => {
        expect(isSupportedContentEncoding("gzip")).toBe(true);
        expect(isSupportedContentEncoding("deflate")).toBe(true);
        expect(isSupportedContentEncoding("br")).toBe(true);
    });

    it("rejects anything else", () => {
        expect(isSupportedContentEncoding("zstd")).toBe(false);
        expect(isSupportedContentEncoding("")).toBe(false);
        expect(isSupportedContentEncoding("GZIP")).toBe(false);
    });
});

describe("decompressBody provider seam", () => {
    it("wraps any provider error as ContentEncodingError preserving the cause", () => {
        // A misbehaving provider can throw anything — http1 maps it onto its own
        // ContentEncodingError so this package's public contract is stable, but
        // the original failure is preserved as `cause` so it is never hidden.
        const boom = new Error("provider crashed");
        const fakeProvider: DecompressionProvider = {
            decompress: () => {
                throw boom;
            },
        };
        try {
            decompressBody(enc(payload), "gzip", fakeProvider);
            expect.unreachable("should have thrown");
        } catch (err) {
            expect(err).toBeInstanceOf(ContentEncodingError);
            expect((err as ContentEncodingError).cause).toBe(boom);
            expect((err as ContentEncodingError).encoding).toBe("gzip");
        }
    });

    it("normalizes a non-Error provider throw into the cause", () => {
        // Providers are not required to throw an Error instance — a string or
        // number must still surface as a ContentEncodingError, not propagate.
        const fakeProvider: DecompressionProvider = {
            decompress: () => {
                throw "raw string throw";
            },
        };
        try {
            decompressBody(enc(payload), "gzip", fakeProvider);
            expect.unreachable("should have thrown");
        } catch (err) {
            expect(err).toBeInstanceOf(ContentEncodingError);
            expect((err as ContentEncodingError).cause).toBeInstanceOf(Error);
        }
    });
});
