import { describe, expect, it } from "vitest";
// Import from the barrel (index.ts) to cover the re-export surface that no
// other test reaches — every other test pulls modules in directly.
import {
    connectHttp1,
    Http1ConnectionImpl,
    Http1Error,
    RedirectLimitError,
    InvalidResponseError,
    ContentEncodingError,
    ChunkEncodingError,
    serializeRequest,
    parseResponse,
    parseChunkedEncoding,
    decompressBody,
    isSupportedContentEncoding,
    followRedirects,
    isRedirectStatus,
    resolveRedirectUrl,
    assertNever,
} from "../src/index.js";

describe("barrel re-exports", () => {
    it("re-exports the public runtime API", () => {
        expect(connectHttp1).toBeTypeOf("function");
        expect(Http1ConnectionImpl).toBeTypeOf("function");
        expect(Http1Error).toBeTypeOf("function");
        expect(RedirectLimitError).toBeTypeOf("function");
        expect(InvalidResponseError).toBeTypeOf("function");
        expect(ContentEncodingError).toBeTypeOf("function");
        expect(ChunkEncodingError).toBeTypeOf("function");
        expect(serializeRequest).toBeTypeOf("function");
        expect(parseResponse).toBeTypeOf("function");
        expect(parseChunkedEncoding).toBeTypeOf("function");
        expect(decompressBody).toBeTypeOf("function");
        expect(isSupportedContentEncoding).toBeTypeOf("function");
        expect(followRedirects).toBeTypeOf("function");
        expect(isRedirectStatus).toBeTypeOf("function");
        expect(resolveRedirectUrl).toBeTypeOf("function");
        expect(assertNever).toBeTypeOf("function");
    });
});
