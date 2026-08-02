/**
 * HTTP/1.1 connection implementation.
 *
 * Wires the message parser/serializer over a `@browsercore/transport` duplex byte
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
    private buffer: Uint8Array = new Uint8Array(0);

    /** Resolvers awaiting the next `data` event from the transport. */
    private dataWaiters: Array<(data: Uint8Array) => void> = [];

    /** Resolvers awaiting connection close (used by `close()` to drain in-flight). */
    private closeWaiters: Array<() => void> = [];

    /** Set once the transport has closed unexpectedly (remote close / error). */
    private transportClosed = false;

    /**
     * Number of requests currently in flight. Held as a field rather than
     * derived from `state` because `close()` transitions the discriminant to
     * `"closing"` while requests are still pending — deriving the count from
     * the discriminant would read 0 in that state and the final request's
     * finally block would never wake the draining close waiter.
     */
    private pending = 0;

    public constructor(
        id: Http1ConnectionId,
        private readonly options: Http1Options,
    ) {
        this.id = id;
        this.options.transport.on("data", (chunk: Uint8Array): void => {
            this.appendBuffer(chunk);
            const waiter = this.dataWaiters.shift();
            if (waiter !== undefined) {
                waiter(chunk);
            }
        });
        this.options.transport.on("close", (): void => {
            this.transportClosed = true;
            // Wake any pending reads so they can observe the closed transport.
            while (this.dataWaiters.length > 0) {
                const waiter = this.dataWaiters.shift();
                if (waiter !== undefined) {
                    waiter(new Uint8Array(0));
                }
            }
        });
    }

    public async request(req: HttpRequest): Promise<HttpResponse> {
        this.ensureOpen();

        this.pending += 1;
        this.transition({ state: "in_flight", pending: this.pending });

        try {
            // Cookie seam (optional): inject request cookies before serializing.
            const interceptor = this.options.cookieInterceptor;
            let wireReq = req;
            if (interceptor?.addCookies !== undefined) {
                wireReq = this.injectCookies(req, interceptor.addCookies(this.cookieUrl(req)));
            }
            const wire = serializeRequest(wireReq);
            await this.options.transport.write(wire);
            const response = await this.readResponse();
            // Cookie seam (optional): collect response Set-Cookie headers.
            if (interceptor?.storeCookies !== undefined) {
                interceptor.storeCookies(this.cookieUrl(wireReq), collectSetCookie(response.headers));
            }
            return response;
        } finally {
            this.pending -= 1;
            if (this.pending === 0) {
                this.transition({ state: "idle" });
                if (this.closeWaiters.length > 0) {
                    for (const waiter of this.closeWaiters) {
                        waiter();
                    }
                    this.closeWaiters = [];
                }
            } else {
                this.transition({ state: "in_flight", pending: this.pending });
            }
        }
    }

    public async close(reason?: Http1CloseReason): Promise<void> {
        const effectiveReason: Http1CloseReason = reason ?? { kind: "client_close" };
        if (this.isClosedOrClosing()) {
            return;
        }

        // If requests are in flight, wait for them to drain before closing.
        if (this.pending > 0) {
            this.transition({ state: "closing" });
            await new Promise<void>((resolve) => {
                this.closeWaiters.push(resolve);
            });
        }

        if (this.isClosedOrClosing()) {
            return;
        }
        this.transition({ state: "closed", reason: effectiveReason });
        await this.options.transport.close();
    }

    private isClosedOrClosing(): boolean {
        const s = this.state.state;
        return s === "closed" || s === "closing";
    }

    /** Read bytes from the transport until a complete response is available. */
    private async readResponse(): Promise<HttpResponse> {
        while (true) {
            const parsed = await this.tryParse();
            if (parsed !== undefined) {
                return parsed;
            }
            const chunk = await this.readChunk();
            if (chunk === undefined) {
                // Transport closed mid-response — drain what we have.
                if (this.buffer.length > 0) {
                    const { response } = parseResponse(this.buffer);
                    this.buffer = this.buffer.slice(0, 0);
                    return this.decodeBody(response);
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
    private async tryParse(): Promise<HttpResponse | undefined> {
        const headerEnd = findHeaderEnd(this.buffer);
        if (headerEnd === -1) {
            return undefined;
        }

        const bodyStart = headerEnd + 4;
        const headerText = decodeAscii(this.buffer, 0, headerEnd);

        const contentLength = extractContentLength(headerText);
        const isChunked = isChunkedEncoding(headerText);

        if (contentLength !== undefined) {
            const totalLength = bodyStart + contentLength;
            if (this.buffer.length < totalLength) {
                return undefined;
            }
            const parsed = await this.parseAndDrain(totalLength);
            return parsed;
        }

        if (isChunked) {
            const bodyEnd = findChunkedBodyEnd(this.buffer, bodyStart);
            if (bodyEnd === -1) {
                return undefined;
            }
            const parsed = await this.parseAndDrain(bodyEnd);
            return parsed;
        }

        // No content-length and not chunked — the body runs until the transport
        // closes, so its boundary can't be determined from headers alone. Return
        // undefined and let `readResponse` observe the close (via `readChunk`
        // resolving `undefined`) and drain whatever the buffer holds.
        return undefined;
    }

    /**
     * Parse the first `totalLength` bytes, drain them from the buffer, then
     * decode transfer-encoding (chunked) and content-encoding in the correct
     * order: transfer-encoding first (it's the outer framing), then
     * content-encoding on the reassembled bytes.
     */
    private parseAndDrain(totalLength: number): Promise<HttpResponse> {
        const { response, bytesConsumed } = parseResponse(this.buffer.slice(0, totalLength));
        this.buffer = this.buffer.slice(bytesConsumed);
        return this.decodeBody(response);
    }

    /**
     * Apply transfer-encoding (chunked) decoding then content-encoding
     * decompression to a parsed response's body. `parseResponse` is kept pure
     * (wire-format only); this is where protocol semantics get applied.
     */
    private async decodeBody(response: HttpResponse): Promise<HttpResponse> {
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
    private readChunk(): Promise<Uint8Array | undefined> {
        return new Promise((resolve: (value?: Uint8Array) => void) => {
            this.dataWaiters.push((chunk: Uint8Array) => {
                if (this.transportClosed && chunk.length === 0) {
                    resolve();
                } else {
                    resolve(chunk);
                }
            });
        });
    }

    private appendBuffer(chunk: Uint8Array): void {
        if (chunk.length === 0) {
            return;
        }
        const next = new Uint8Array(this.buffer.length + chunk.length);
        next.set(this.buffer, 0);
        next.set(chunk, this.buffer.length);
        this.buffer = next;
    }

    private ensureOpen(): void {
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

    private transition(next: Http1ConnectionState): void {
        this.state = next;
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
    private cookieUrl(req: HttpRequest): { host: string; path: string; protocol: string } {
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
    private injectCookies(
        req: HttpRequest,
        cookies: Map<string, string> | string,
    ): HttpRequest {
        if (typeof cookies === "string") {
            if (cookies === "") {
                return req;
            }
            const headers = new Map([...req.headers, ["cookie", cookies]]);
            return { ...req, headers };
        }
        if (cookies.size === 0) {
            return req;
        }
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
export function connectHttp1(options: Http1Options): Promise<Http1Connection> {
    const id = createId("http1");
    return Promise.resolve(new Http1ConnectionImpl(id, options));
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
        const byte = buf[i];
        if (byte === undefined) {
            throw new Error("decodeAscii: index out of bounds");
        }
        out += String.fromCodePoint(byte);
    }
    return out;
}

/** Extract the `content-length` header value, or `undefined` if absent. */
function extractContentLength(headerText: string): number | undefined {
    const match = /(?:^|\n)content-length:\s*(\d+)\r?/iu.exec(headerText);
    if (match === null) {
        return undefined;
    }
    const value = match[1];
    return value === undefined ? undefined : Number(value);
}

/** Whether the response uses chunked transfer-encoding. */
function isChunkedEncoding(headerText: string): boolean {
    const match = /(?:^|\n)transfer-encoding:\s*([^\r\n]+)/iu.exec(headerText);
    if (match === null) {
        return false;
    }
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
        if (lineEnd === -1) {
            return -1;
        }

        const sizeLine = decodeAscii(buf, offset, lineEnd);
        // exec returns null (not undefined) when there is no match.
        if (!/^[0-9a-fA-F]+(?:;[^\r\n]*)?$/u.test(sizeLine)) {
            return -1;
        }

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

        if (chunkEnd > buf.length) {
            return -1;
        }
        if (buf[dataEnd] !== 0x0d || buf[dataEnd + 1] !== 0x0a) {
            return -1;
        }

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
        if (buf[i] !== 0x0d || buf[i + 1] !== 0x0a) {
            continue;
        }
        if (i === lineStart) {
            return i + 2; // blank line — end of trailers
        }
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
            return assertNever(reason);
    }
}

// --- Body decoding helpers -----------------------------------------------

/** Yield the bytes of a single buffer as an `AsyncIterable` (one chunk). */
function chunkIterable(buf: Uint8Array): AsyncIterable<Uint8Array> {
    let yielded = false;
    return {
        [Symbol.asyncIterator]() {
            return {
                next(): Promise<IteratorResult<Uint8Array>> {
                    if (buf.length === 0 || yielded) {
                        return Promise.resolve({ value: undefined, done: true });
                    }
                    yielded = true;
                    return Promise.resolve({ value: buf, done: false });
                },
            };
        },
    };
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
        if (name === "set-cookie") {
            out.push(value);
        }
    }
    return out;
}
