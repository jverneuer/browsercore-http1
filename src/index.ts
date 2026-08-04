/**
 * @browsercore/http1 — public API surface.
 *
 * HTTP/1.1 client over any duplex byte stream. No knowledge of TLS or TCP.
 * Higher layers (cookies, fetch, profiles) compose exclusively through these exports.
 */

export { connectHttp1, Http1ConnectionImpl } from "./connection.js";

export {
    ChunkEncodingError,
    ConnectionClosedError,
    ConnectionClosingError,
    ContentEncodingError,
    DecodeError,
    Http1Error,
    InvalidResponseError,
    RedirectLimitError,
} from "./errors.js";

export {
    type Headers,
    type ParseResponseResult,
    type StartLine,
    parseChunkedEncoding,
    parseResponse,
    serializeRequest,
} from "./message.js";

export {
    decompressBody,
    isSupportedContentEncoding,
    type ContentEncoding,
    type DecompressionProvider,
} from "./decompress.js";

export {
    followRedirects,
    isRedirectStatus,
    resolveRedirectUrl,
    type FollowRedirectsOptions,
    type RedirectStatusCode,
} from "./redirect.js";

export {
    type Http1CloseReason,
    type Http1Connection,
    type Http1ConnectionId,
    type Http1ConnectionState,
    type Http1Options,
    type HttpBodyKind,
    type HttpMethod,
    type HttpRequest,
    type HttpResponse,
    type CookieInterceptor,
    type CookieUrl,
    type Logger,
} from "./types.js";
export { silentLogger, devLogger } from "./types.js";

export { assertNever } from "./utils.js";
