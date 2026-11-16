import { describe, expect, it } from "vitest";
import { FakeTransportBase } from "./test-helpers.js";
import { connectHttp1 } from "../src/connection.js";
import type { HttpRequest } from "../src/types.js";

/**
 * A fake in-memory transport that answers each write with the next queued
 * response and also supports hand-driven byte delivery. Tracks whether a
 * `close` event was ever emitted so a test can assert that a body-less
 * response resolved WITHOUT any close-delimiting wait (issue #42: a HEAD
 * response with no framing headers used to stall until the transport closed —
 * which never happens on keep-alive — and the eventual pool timeout then tore
 * the connection down).
 *
 * Composes an injected EventProvider (via FakeTransportBase) rather than
 * extending node:events — matches the production Transport pattern.
 */
class FramingTransport extends FakeTransportBase {
    public readonly written: Uint8Array[] = [];
    public remoteCloseEmitted = false;
    private readonly responses: Uint8Array[] = [];

    public constructor() {
        super("framing");
        this.on("close", (): void => {
            this.remoteCloseEmitted = true;
        });
    }

    public queueResponse(bytes: Uint8Array): void {
        this.responses.push(bytes);
    }

    public async write(data: Uint8Array): Promise<void> {
        this.written.push(data);
        const next = this.responses.shift();
        if (next !== undefined) {
            queueMicrotask(() => this.events.emit("data", next));
        }
    }

    /** Emit bytes by hand, as a real socket would. */
    public pushData(chunk: Uint8Array): void {
        this.events.emit("data", chunk);
    }

    /** Emit a `close` event without going through the graceful close handshake. */
    public closeRemote(): void {
        this.events.emit("close", false);
    }
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/**
 * Build a raw HTTP/1.1 response. `statusLine` is passed verbatim so tests can
 * pin the exact wire bytes (status text matters for the 204/304/1xx cases).
 */
function rawResponse(statusLine: string, headers: Record<string, string>, body = ""): Uint8Array {
    const lines = [statusLine];
    for (const [name, value] of Object.entries(headers)) {
        lines.push(`${name}: ${value}`);
    }
    lines.push("", "");
    return enc(`${lines.join("\r\n")}${body}`);
}

const headReq = (url = "/resource"): HttpRequest => ({
    method: "HEAD",
    url,
    headers: new Map([["host", "example.com"]]),
    body: { kind: "empty" as const },
});

const getReq = (url = "/resource"): HttpRequest => ({
    method: "GET",
    url,
    headers: new Map([["host", "example.com"]]),
    body: { kind: "empty" as const },
});

/** A HEAD response the way most servers send it: no framing headers at all. */
const HEAD_NO_FRAMING = rawResponse("HTTP/1.1 200 OK", { "content-type": "text/html" });

/** A GET response with a real body, used to prove keep-alive reuse. */
const GET_WITH_BODY = rawResponse("HTTP/1.1 200 OK", { "content-length": "5" }, "hello");

describe("body-less response framing (RFC 9110 §9.3.3 / RFC 9112 §6.3)", () => {
    it("resolves a HEAD response with no framing headers immediately, without any close", async () => {
        const transport = new FramingTransport();
        transport.queueResponse(HEAD_NO_FRAMING);
        const conn = await connectHttp1({ transport });

        const start = performance.now();
        const response = await conn.request(headReq());
        const elapsedMs = performance.now() - start;

        expect(response.statusCode).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/html");
        // The response is body-less even though the server advertised a body
        // framing (none here) — and it must resolve on the header terminator
        // alone, far below the ~6s pool teardown stall this fix replaces.
        expect(response.body.length).toBe(0);
        expect(elapsedMs).toBeLessThan(1000);
        // No close event ever fired — the read did NOT fall back to
        // close-delimiting, and the connection stayed open for reuse.
        expect(transport.remoteCloseEmitted).toBe(false);
        expect(transport.state.state).toBe("open");
        // The request finished — the connection is idle, not stuck in_flight.
        expect(conn.state).toEqual({ state: "idle" });
        await conn.close();
    });

    it("keeps the keep-alive connection reusable for a follow-up GET after a HEAD", async () => {
        const transport = new FramingTransport();
        transport.queueResponse(HEAD_NO_FRAMING);
        transport.queueResponse(GET_WITH_BODY);
        const conn = await connectHttp1({ transport });

        const head = await conn.request(headReq("/page"));
        expect(head.body.length).toBe(0);

        // The header block was drained exactly — the GET below parses from a
        // clean buffer, proving the connection stayed in frame-sync.
        const get = await conn.request(getReq("/page"));
        expect(get.statusCode).toBe(200);
        expect(dec(get.body)).toBe("hello");

        // Both requests went over the SAME transport — keep-alive preserved.
        expect(transport.written.length).toBe(2);
        await conn.close();
    });

    it("resolves a HEAD response that lies about content-length", async () => {
        // RFC 9110 §9.3.3: a HEAD response MAY carry content-length — the value
        // describes what an equivalent GET would return, never this message.
        // Framing must not wait for 1234 body bytes that will never arrive.
        const transport = new FramingTransport();
        transport.queueResponse(
            rawResponse("HTTP/1.1 200 OK", { "content-length": "1234", "content-type": "video/mp4" }),
        );
        transport.queueResponse(GET_WITH_BODY);
        const conn = await connectHttp1({ transport });

        const start = performance.now();
        const head = await conn.request(headReq());
        expect(performance.now() - start).toBeLessThan(1000);
        expect(head.body.length).toBe(0);
        expect(head.headers.get("content-length")).toBe("1234");

        const get = await conn.request(getReq());
        expect(dec(get.body)).toBe("hello");
        expect(transport.written.length).toBe(2);
        await conn.close();
    });

    it("resolves a HEAD response that claims chunked transfer-encoding", async () => {
        // A HEAD response may advertise chunked (what the GET would use). The
        // empty body must NOT be fed through the chunked decoder — that would
        // throw ChunkEncodingError ("stream ended before the zero chunk").
        const transport = new FramingTransport();
        transport.queueResponse(
            rawResponse("HTTP/1.1 200 OK", { "transfer-encoding": "chunked" }),
        );
        transport.queueResponse(GET_WITH_BODY);
        const conn = await connectHttp1({ transport });

        const head = await conn.request(headReq());
        expect(head.body.length).toBe(0);
        expect(head.headers.get("transfer-encoding")).toBe("chunked");

        const get = await conn.request(getReq());
        expect(dec(get.body)).toBe("hello");
        await conn.close();
    });

    it("resolves a HEAD response carrying both lying framing headers", async () => {
        const transport = new FramingTransport();
        transport.queueResponse(
            rawResponse("HTTP/1.1 200 OK", { "content-length": "7", "transfer-encoding": "chunked" }),
        );
        const conn = await connectHttp1({ transport });

        const head = await conn.request(headReq());
        expect(head.body.length).toBe(0);
        expect(transport.remoteCloseEmitted).toBe(false);
        expect(conn.state).toEqual({ state: "idle" });
        await conn.close();
    });

    it("treats a 204 with a content-length header as body-less", async () => {
        // 204 is body-less regardless of header fields (RFC 9112 §6.3).
        const transport = new FramingTransport();
        transport.queueResponse(rawResponse("HTTP/1.1 204 No Content", { "content-length": "5678" }));
        transport.queueResponse(GET_WITH_BODY);
        const conn = await connectHttp1({ transport });

        const start = performance.now();
        const response = await conn.request(getReq());
        expect(performance.now() - start).toBeLessThan(1000);
        expect(response.statusCode).toBe(204);
        expect(response.body.length).toBe(0);

        // Buffer stayed in sync — the next request on the same connection works.
        const next = await conn.request(getReq("/after"));
        expect(dec(next.body)).toBe("hello");
        await conn.close();
    });

    it("treats a 304 with a content-length header as body-less", async () => {
        // A 304 may carry the headers the 200 would have had — including
        // content-length (RFC 9110 §15.4.5). Still body-less.
        const transport = new FramingTransport();
        transport.queueResponse(
            rawResponse("HTTP/1.1 304 Not Modified", { "content-length": "9999", etag: '"abc"' }),
        );
        transport.queueResponse(GET_WITH_BODY);
        const conn = await connectHttp1({ transport });

        const response = await conn.request(getReq());
        expect(response.statusCode).toBe(304);
        expect(response.body.length).toBe(0);
        expect(response.headers.get("etag")).toBe('"abc"');

        const next = await conn.request(getReq("/after"));
        expect(dec(next.body)).toBe("hello");
        await conn.close();
    });

    it("treats a 1xx interim response as body-less and stays frame-synced", async () => {
        // 1xx responses are terminated by the first empty line after the
        // header fields (RFC 9112 §6.3) — resolve immediately, never wait.
        const transport = new FramingTransport();
        transport.queueResponse(rawResponse("HTTP/1.1 100 Continue", {}));
        transport.queueResponse(GET_WITH_BODY);
        const conn = await connectHttp1({ transport });

        const start = performance.now();
        const interim = await conn.request(getReq());
        expect(performance.now() - start).toBeLessThan(1000);
        expect(interim.statusCode).toBe(100);
        expect(interim.body.length).toBe(0);

        // The interim response was drained exactly; the final response that
        // follows on the wire parses cleanly as the next message.
        const final = await conn.request(getReq());
        expect(final.statusCode).toBe(200);
        expect(dec(final.body)).toBe("hello");
        await conn.close();
    });

    it("still close-delimits a body-less-framed GET when no framing headers exist", async () => {
        // Guard against over-firing: the fix must only change HEAD/1xx/204/304
        // framing. A regular GET without content-length or chunked keeps the
        // close-delimited read (body runs until the transport closes).
        const transport = new FramingTransport();
        const conn = await connectHttp1({ transport });

        const pending = conn.request(getReq());
        transport.pushData(enc("HTTP/1.1 200 OK\r\n\r\nstreamed-body"));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(transport.remoteCloseEmitted).toBe(false);

        transport.pushData(enc(" and more"));
        await new Promise((resolve) => setTimeout(resolve, 0));

        // The close-delimited body resolves only on the transport close —
        // exactly the path a body-less-framed GET is still allowed to take.
        transport.closeRemote();

        expect(dec((await pending).body)).toBe("streamed-body and more");
        await conn.close();
    });
});
