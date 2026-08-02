/**
 * HTTP/1.1 connection implementation.
 *
 * Wires the message parser/serializer over a `@network/transport` duplex byte
 * stream. Handles keep-alive via serial request/response on a single connection.
 */

import type {
    Http1CloseReason,
    Http1Connection,
    Http1ConnectionId,
    Http1ConnectionState,
    Http1Options,
    HttpRequest,
    HttpResponse,
} from "./types.js";
import { parseResponse, serializeRequest, parseChunkedEncoding } from "./message.js";
import { decompressBody } from "./decompress.js";
import { assertNever, createId } from "./utils.js";

/** Concrete HTTP/1.1 connection. */
export class Http1ConnectionImpl implements Http1Connection {
    public readonly id: Http1ConnectionId;
    public state: Http1ConnectionState = { state: "idle" };

    /**
     * Incoming bytes not yet consumed by a parsed response. Drained by
     * `bytesConsumed` after every parse — this is what makes keep-alive work.
     */
    private _buffer: Uint8Array = new Uint8Array(0);

    /** Resolvers awaiting the next `data` event from the transport. */
    private _dataWaiters: Array<(data: Uint8Array) => void> = [];

    /** Resolvers awaiting connection close (used by `close()` to drain in-flight). */
    private _closeWaiters: Array<() => void> = [];

    /** Set once the transport has closed unexpectedly (remote close / error). */
    private _transportClosed = false;

    public constructor(
        id: Http1ConnectionId,
        private readonly _options: Http1Options,
    ) {
        this.id = id;
        this._options.transport.on("data", (chunk: Uint8Array): void => {
            this._appendBuffer(chunk);
            const waiter = this._dataWaiters.shift();
            if (waiter !== undefined) {
                waiter(chunk);
            }
        });
        this._options.transport.on("close", (): void => {
            this._transportClosed = true;
            // Wake any pending reads so they can observe the closed transport.
            while (this._dataWaiters.length > 0) {
                const waiter = this._dataWaiters.shift();
                if (waiter !== undefined) waiter(new Uint8Array(0));
            }
        });
    }

    public async request(req: HttpRequest): Promise<HttpResponse> {
        this._ensureOpen();

        this._transition({ state: "in_flight", pending: this._pendingCount() + 1 });

        try {
            // Cookie seam (optional): inject request cookies before serializing.
            const interceptor = this._options.cookieInterceptor;
            let wireReq = req;
            if (interceptor?.addCookies !== undefined) {
                wireReq = this._injectCookies(req, interceptor.addCookies(this._cookieUrl(req)));
            }
            const wire = serializeRequest(wireReq);
            await this._options.transport.write(wire);
            const response = await this._readResponse();
            // Cookie seam (optional): collect response Set-Cookie headers.
            if (interceptor?.storeCookies !== undefined) {
                interceptor.storeCookies(this._cookieUrl(wireReq), collectSetCookie(response.headers));
            }
            return response;
        } finally {
            const pending = this._pendingCount() - 1;
            if (pending === 0) {
                this._transition({ state: "idle" });
                if (this._closeWaiters.length > 0) {
                    for (const waiter of this._closeWaiters) waiter();
                    this._closeWaiters = [];
                }
            } else {
                this._transition({ state: "in_flight", pending });
            }
        }
    }

    public async close(reason?: Http1CloseReason): Promise<void> {
        const effectiveReason: Http1CloseReason = reason ?? { kind: "client_close" };
        if (this._isClosedOrClosing()) return;

        // If requests are in flight, wait for them to drain before closing.
        if (this._pendingCount() > 0) {
            this._transition({ state: "closing" });
            await new Promise<void>((resolve) => {
                this._closeWaiters.push(resolve);
            });
        }

        if (this._isClosedOrClosing()) return;
        this._transition({ state: "closed", reason: effectiveReason });
        await this._options.transport.close();
    }

    private _isClosedOrClosing(): boolean {
        const s = this.state.state;
        return s === "closed" || s === "closing";
    }

    /** Read bytes from the transport until a complete response is available. */
    private async _readResponse(): Promise<HttpResponse> {
        while (true) {
            const parsed = await this._tryParse();
            if (parsed !== undefined) {
                return parsed;
            }
            const chunk = await this._readChunk();
            if (chunk === undefined) {
                // Transport closed mid-response — drain what we have.
                if (this._buffer.length > 0) {
                    const { response } = parseResponse(this._buffer);
                    this._buffer = this._buffer.slice(0, 0);
                    return this._decodeBody(response);
                }
                throw new Error("transport closed before response received");
            }
            // The chunk was already appended to the buffer by the "data" event
            // handler, which also woke this waiter. Nothing more to do here.
            void chunk;
        }
    }

    /**
     * Attempt to parse a complete response from the current buffer.
     * Returns `undefined` if more bytes are needed.
     */
    private async _tryParse(): Promise<HttpResponse | undefined> {
        const headerEnd = findHeaderEnd(this._buffer);
        if (headerEnd === -1) return undefined;

        const bodyStart = headerEnd + 4;
        const headerText = decodeAscii(this._buffer, 0, headerEnd);

        const contentLength = extractContentLength(headerText);
        const isChunked = isChunkedEncoding(headerText);

        if (contentLength !== undefined) {
            const totalLength = bodyStart + contentLength;
            if (this._buffer.length < totalLength) return undefined;
            return await this._parseAndDrain(totalLength);
        }

        if (isChunked) {
            const bodyEnd = findChunkedBodyEnd(this._buffer, bodyStart);
            if (bodyEnd === -1) return undefined;
            return await this._parseAndDrain(bodyEnd);
        }

        // No content-length and not chunked — body runs until transport close.
        if (!this._transportClosed) return undefined;
        return await this._parseAndDrain(this._buffer.length);
    }

    /**
     * Parse the first `totalLength` bytes, drain them from the buffer, then
     * decode transfer-encoding (chunked) and content-encoding in the correct
     * order: transfer-encoding first (it's the outer framing), then
     * content-encoding on the reassembled bytes.
     */
    private async _parseAndDrain(totalLength: number): Promise<HttpResponse> {
        const { response, bytesConsumed } = parseResponse(this._buffer.slice(0, totalLength));
        this._buffer = this._buffer.slice(bytesConsumed);
        return this._decodeBody(response);
    }

    /**
     * Apply transfer-encoding (chunked) decoding then content-encoding
     * decompression to a parsed response's body. `parseResponse` is kept pure
     * (wire-format only); this is where protocol semantics get applied.
     */
    private async _decodeBody(response: HttpResponse): Promise<HttpResponse> {
        const headers = response.headers;
        let body = response.body;

        const isChunked = headers.get("transfer-encoding");
        if (isChunked !== undefined && isChunked.toLowerCase().includes("chunked")) {
            body = await materialize(parseChunkedEncoding(chunkIterable(body)));
        }

        const contentEncoding = headers.get("content-encoding");
        if (contentEncoding !== undefined) {
            body = decompressBody(body, contentEncoding);
        }

        return {
            statusCode: response.statusCode,
            statusText: response.statusText,
            headers,
            body,
        };
    }

    /** Read one chunk from the transport, or `undefined` once it has closed. */
    private async _readChunk(): Promise<Uint8Array | undefined> {
        return new Promise<Uint8Array | undefined>((resolve) => {
            this._dataWaiters.push((chunk: Uint8Array) => {
                if (this._transportClosed && chunk.length === 0) {
                    resolve(undefined);
                } else {
                    resolve(chunk);
                }
            });
        });
    }

    private _appendBuffer(chunk: Uint8Array): void {
        if (chunk.length === 0) return;
        const next = new Uint8Array(this._buffer.length + chunk.length);
        next.set(this._buffer, 0);
        next.set(chunk, this._buffer.length);
        this._buffer = next;
    }

    private _ensureOpen(): void {
        const s = this.state;
        switch (s.state) {
            case "idle":
            case "in_flight":
                return;
            case "closing":
                throw new Error("connection is closing — no new requests allowed");
            case "closed":
                throw new Error(`connection is closed: ${describeCloseReason(s.reason)}`);
            default:
                assertNever(s);
        }
    }

    private _transition(next: Http1ConnectionState): void {
        this.state = next;
    }

    /** Derive the current pending count from the state. */
    private _pendingCount(): number {
        const s = this.state;
        if (s.state === "in_flight") return s.pending;
        return 0;
    }

    /**
     * Build the cookie-matching URL for a request.
     *
     * http1 is scheme-agnostic — TLS lives below the transport, so the protocol
     * is not known here. We derive `host` from the `host` header and `path` from
     * the request target, and default `protocol` to `https:` as a best-effort
     * (this stack is built for TLS). The seam is optional and only invoked when
     * a caller supplies an interceptor.
     */
    private _cookieUrl(req: HttpRequest): { host: string; path: string; protocol: string } {
        const host = req.headers.get("host") ?? "";
        return {
            host: host.split(":")[0] ?? host,
            path: new URL(`http://${host}${req.url}`).pathname,
            protocol: "https:",
        };
    }

    /**
     * Merge cookies returned by the interceptor into a request. A bare string
     * is treated as the `Cookie` header value; a map is merged name->value.
     */
    private _injectCookies(
        req: HttpRequest,
        cookies: Map<string, string> | string,
    ): HttpRequest {
        if (typeof cookies === "string") {
            if (cookies === "") return req;
            const headers = new Map(req.headers);
            headers.set("cookie", cookies);
            return { ...req, headers };
        }
        if (cookies.size === 0) return req;
        const headers = new Map(req.headers);
        for (const [name, value] of cookies) {
            headers.set(name, value);
        }
        return { ...req, headers };
    }
}

/**
 * Establish an HTTP/1.1 connection over an existing transport.
 *
 * The transport is assumed to be already connected — this function only wraps
 * it with the HTTP/1.1 protocol state machine.
 */
export async function connectHttp1(options: Http1Options): Promise<Http1Connection> {
    const id = createId("http1");
    return new Http1ConnectionImpl(id, options);
}

// --- Byte-level helpers --------------------------------------------------

/** Find the offset of the `\r\n\r\n` header terminator, or -1 if not present. */
function findHeaderEnd(buf: Uint8Array): number {
    for (let i = 0; i + 3 < buf.length; i++) {
        if (
            buf[i] === 0x0d &&
            buf[i + 1] === 0x0a &&
            buf[i + 2] === 0x0d &&
            buf[i + 3] === 0x0a
        ) {
            return i;
        }
    }
    return -1;
}

/** Decode a slice of bytes as ASCII without going through `Buffer`. */
function decodeAscii(buf: Uint8Array, start: number, end: number): string {
    let out = "";
    for (let i = start; i < end; i++) {
        out += String.fromCharCode(buf[i]!);
    }
    return out;
}

/** Extract the `content-length` header value, or `undefined` if absent. */
function extractContentLength(headerText: string): number | undefined {
    const match = /(?:^|\n)content-length:\s*(\d+)\r?/i.exec(headerText);
    if (match === null) return undefined;
    const value = match[1];
    return value === undefined ? undefined : Number(value);
}

/** Whether the response uses chunked transfer-encoding. */
function isChunkedEncoding(headerText: string): boolean {
    const match = /(?:^|\n)transfer-encoding:\s*([^\r\n]+)/i.exec(headerText);
    if (match === null) return false;
    const value = match[1];
    return value !== undefined && value.toLowerCase().includes("chunked");
}

/**
 * Find the offset just past the end of a chunked body in `buf`, starting the
 * scan at `bodyStart`. Returns -1 if the terminating chunk has not arrived.
 */
function findChunkedBodyEnd(buf: Uint8Array, bodyStart: number): number {
    let offset = bodyStart;
    while (offset < buf.length) {
        // Find the end of the chunk-size line.
        let lineEnd = -1;
        for (let i = offset; i + 1 < buf.length; i++) {
            if (buf[i] === 0x0d && buf[i + 1] === 0x0a) {
                lineEnd = i;
                break;
            }
        }
        if (lineEnd === -1) return -1;

        const sizeLine = decodeAscii(buf, offset, lineEnd);
        // exec returns null (not undefined) when there is no match.
        if (!/^[0-9a-fA-F]+(?:;[^\r\n]*)?$/.test(sizeLine)) return -1;

        const size = Number.parseInt(sizeLine, 16);
        const dataStart = lineEnd + 2;

        if (size === 0) {
            // last-chunk = "1*("0") [ chunk-ext ] CRLF" — no chunk-data, no
            // trailing data CRLF. dataStart points just past the "0\r\n".
            // trailer-part follows: zero or more header-field lines, then a
            // final blank line. consumeTrailers returns the offset just past
            // that final blank line, or -1 if the buffer doesn't hold it all.
            const trailerEnd = consumeTrailers(buf, dataStart);
            return trailerEnd === -1 ? -1 : trailerEnd;
        }

        const dataEnd = dataStart + size;
        const chunkEnd = dataEnd + 2; // trailing \r\n after chunk data

        if (chunkEnd > buf.length) return -1;
        if (buf[dataEnd] !== 0x0d || buf[dataEnd + 1] !== 0x0a) return -1;

        offset = chunkEnd;
    }
    return -1;
}

/**
 * Consume the trailer section (zero or more header-field lines + a final blank
 * line) starting at `start`. Returns the offset just past the terminating blank
 * line, or -1 if the buffer does not yet hold the full trailer section.
 *
 * A blank line is a `CRLF` at `lineStart` — i.e. two consecutive CRLFs with no
 * header content between them. This mirrors the trailer handling in
 * `parseChunkedEncoding`.
 */
function consumeTrailers(buf: Uint8Array, start: number): number {
    let lineStart = start;
    for (let i = start; i + 1 < buf.length; i++) {
        if (buf[i] !== 0x0d || buf[i + 1] !== 0x0a) continue;
        if (i === lineStart) return i + 2; // blank line — end of trailers
        lineStart = i + 2;
    }
    return -1;
}

/** Human-readable description of a close reason — for error messages. */
function describeCloseReason(reason: Http1CloseReason): string {
    switch (reason.kind) {
        case "client_close":
            return "client closed";
        case "remote_close":
            return "remote closed";
        case "error":
            return `error: ${reason.error.message}`;
        case "redirect_jump":
            return `redirect to ${reason.to}`;
        default:
            assertNever(reason);
    }
}

// --- Body decoding helpers -----------------------------------------------

/** Yield the bytes of a single buffer as an `AsyncIterable` (one chunk). */
async function* chunkIterable(buf: Uint8Array): AsyncGenerator<Uint8Array> {
    if (buf.length > 0) yield buf;
}

/** Collect all chunks of an async byte stream into one contiguous buffer. */
async function materialize(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream) {
        chunks.push(chunk);
        total += chunk.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

/** Collect all `set-cookie` header values (case-insensitive) in wire order. */
function collectSetCookie(headers: ReadonlyMap<string, string>): string[] {
    const out: string[] = [];
    for (const [name, value] of headers) {
        if (name === "set-cookie") out.push(value);
    }
    return out;
}

