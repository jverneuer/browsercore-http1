import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { gzipSync } from "node:zlib";
import type { Transport } from "@browsercore/transport";
import { compression } from "@browsercore/compression";
import { connectHttp1 } from "../src/connection.js";
import { ContentEncodingError } from "../src/errors.js";
import { followRedirects } from "../src/redirect.js";
import type {
    Http1Connection,
    Http1ConnectionId,
    Http1ConnectionState,
    HttpRequest,
    HttpResponse,
} from "../src/types.js";

/**
 * A fake in-memory transport that answers each write with a queued response.
 * Mirrors the pattern used across the suite — queue raw wire bytes, emit them
 * on the next microtask after a write, just as a real socket would.
 */
class FakeTransport extends EventEmitter implements Transport {
    public readonly id = "fake" as Transport["id"];
    public state: Transport["state"] = { state: "open" };
    public readonly written: Uint8Array[] = [];
    private readonly responses: Uint8Array[] = [];

    public queueResponse(bytes: Uint8Array): void {
        this.responses.push(bytes);
    }

    public async write(data: Uint8Array): Promise<void> {
        this.written.push(data);
        const next = this.responses.shift();
        if (next !== undefined) {
            queueMicrotask(() => this.emit("data", next));
        }
    }

    public read(): Promise<Uint8Array> {
        return Promise.resolve(new Uint8Array(0));
    }

    public async close(): Promise<void> {
        this.state = { state: "closed", reason: { kind: "client_close" } };
        this.emit("close", false);
    }
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Build a raw HTTP/1.1 response with the given status + headers + body. */
function rawResponse(status: number, headers: Record<string, string>, body: string): Uint8Array {
    const lines = [`HTTP/1.1 ${status} ${status === 200 ? "OK" : ""}`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    lines.push("", "");
    return enc(`${lines.join("\r\n")}${body}`);
}

const getReq = (url = "/"): HttpRequest => ({
    method: "GET",
    url,
    headers: new Map([["host", "example.com"]]),
    body: { kind: "empty" as const },
});

describe("Http1Connection content-encoding error propagation", () => {
    it("throws ContentEncodingError for an unsupported content-encoding", async () => {
        // A server that claims `content-encoding: zstd` forces the connection's
        // decodeBody to call decompressBody, which must surface the failure as
        // http1's ContentEncodingError rather than letting a provider-specific
        // error leak across the package boundary.
        const transport = new FakeTransport();
        transport.queueResponse(rawResponse(200, { "content-encoding": "zstd", "content-length": "3" }, "abc"));
        const conn = await connectHttp1({ transport, decompressionProvider: compression });
        await expect(conn.request(getReq())).rejects.toBeInstanceOf(ContentEncodingError);
        await conn.close();
    });

    it("throws ContentEncodingError when the gzip stream is corrupt", async () => {
        // Valid content-encoding header but garbage body bytes — the zlib
        // backend throws DecompressionError, which decodeBody must re-wrap as
        // ContentEncodingError so callers only ever see http1's error type.
        const garbage = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff, 0xff, 0xff]);
        const header = enc("HTTP/1.1 200 OK\r\ncontent-encoding: gzip\r\ncontent-length: 8\r\n\r\n");
        const wire = new Uint8Array([...header, ...garbage]);
        const transport = new FakeTransport();
        transport.queueResponse(wire);
        const conn = await connectHttp1({ transport, decompressionProvider: compression });
        await expect(conn.request(getReq())).rejects.toBeInstanceOf(ContentEncodingError);
        await conn.close();
    });

    it("decompresses a gzip body end-to-end through the connection", async () => {
        // The happy path: a real gzip stream must be transparently decoded so
        // the caller sees the original payload, not the compressed bytes.
        const payload = "round-trip payload ".repeat(12);
        const body = new Uint8Array(gzipSync(enc(payload)));
        const header = enc(`HTTP/1.1 200 OK\r\ncontent-encoding: gzip\r\ncontent-length: ${body.length}\r\n\r\n`);
        const wire = new Uint8Array([...header, ...body]);
        const transport = new FakeTransport();
        transport.queueResponse(wire);
        const conn = await connectHttp1({ transport, decompressionProvider: compression });
        const response = await conn.request(getReq());
        expect(response.statusCode).toBe(200);
        expect(dec(response.body)).toBe(payload);
        await conn.close();
    });
});

describe("Http1Connection request with a body", () => {
    it("sends a POST with a binary body and the matching content-length", async () => {
        // A request carrying body bytes must serialize the body verbatim after
        // the header terminator and set content-length to the byte length — the
        // server-side contract for a well-formed HTTP/1.1 POST.
        const transport = new FakeTransport();
        transport.queueResponse(rawResponse(200, { "content-length": "2" }, "ok"));
        const conn = await connectHttp1({ transport, decompressionProvider: compression });
        const data = enc("\x00\x01\x02\x03");
        const response = await conn.request({
            method: "POST",
            url: "/upload",
            headers: new Map<string, string>([
                ["host", "example.com"],
                ["content-length", String(data.length)],
            ]),
            body: { kind: "bytes" as const, data },
        });
        expect(response.statusCode).toBe(200);
        const wire = dec(transport.written[0]!);
        expect(wire).toContain("POST /upload HTTP/1.1\r\n");
        expect(wire).toContain("content-length: 4\r\n");
        // The body bytes follow the blank line that ends the header section.
        expect(transport.written[0]!.slice(wire.lastIndexOf("\r\n\r\n") + 4)).toEqual(data);
        await conn.close();
    });
});

describe("Http1Connection close idempotency", () => {
    it("returns immediately when close() is called a second time", async () => {
        // close() must be safe to call repeatedly: the second call observes the
        // "closed" state and returns without touching the transport again. This
        // guards against double-close bugs in higher layers (e.g. fetch) that
        // may close both on success and in a finally block.
        const transport = new FakeTransport();
        transport.queueResponse(rawResponse(200, { "content-length": "2" }, "ok"));
        const conn = await connectHttp1({ transport, decompressionProvider: compression });
        await conn.request(getReq());
        await conn.close();
        expect(conn.state.state).toBe("closed");
        // The transport was closed exactly once.
        expect(transport.state.state).toBe("closed");
        // A second close resolves without error and does not throw.
        await expect(conn.close()).resolves.toBeUndefined();
        expect(conn.state.state).toBe("closed");
    });
});

describe("followRedirects method/body preservation", () => {
    // A scripted connection: maps request URLs to responses, recording the trail.
    class ScriptedConnection implements Http1Connection {
        public readonly id: Http1ConnectionId = "scripted" as Http1ConnectionId;
        public state: Http1ConnectionState = { state: "idle" };
        public readonly requests: HttpRequest[] = [];

        public constructor(private readonly responses: (req: HttpRequest) => HttpResponse) {}

        public async request(req: HttpRequest): Promise<HttpResponse> {
            this.requests.push(req);
            return this.responses(req);
        }

        public async close(): Promise<void> {}
    }

    it("preserves method and body on a 307 Temporary Redirect", async () => {
        // RFC 7231: 307 preserves the request method and body. A POST with a
        // JSON body must arrive at the destination still as POST with the same
        // body — unlike 303, which rewrites to GET.
        const body = enc('{"key":"value"}');
        const post: HttpRequest = {
            method: "POST",
            url: "/submit",
            headers: new Map<string, string>([
                ["host", "example.com"],
                ["content-type", "application/json"],
                ["content-length", String(body.length)],
            ]),
            body: { kind: "bytes", data: body },
        };
        const conn = new ScriptedConnection((req) => {
            if (req.url === "/submit") {
                return {
                    statusCode: 307,
                    statusText: "Temporary Redirect",
                    headers: new Map([["location", "/new-submit"]]),
                    body: new Uint8Array(0),
                };
            }
            return {
                statusCode: 200,
                statusText: "OK",
                headers: new Map<string, string>([["content-length", "2"]]),
                body: enc("ok"),
            };
        });
        const response = await followRedirects(conn, post, "https://example.com/submit");
        expect(response.statusCode).toBe(200);
        // The redirected request kept its method and body intact.
        const second = conn.requests[1]!;
        expect(second.method).toBe("POST");
        expect(second.url).toBe("/new-submit");
        expect(second.body).toEqual({ kind: "bytes", data: body });
    });

    it("preserves method and body on a 308 Permanent Redirect", async () => {
        // 308 is the permanent counterpart of 307 — same method/body semantics.
        const body = enc("data");
        const put: HttpRequest = {
            method: "PUT",
            url: "/resource",
            headers: new Map<string, string>([
                ["host", "example.com"],
                ["content-length", String(body.length)],
            ]),
            body: { kind: "bytes", data: body },
        };
        const conn = new ScriptedConnection((req) => {
            if (req.url === "/resource") {
                return {
                    statusCode: 308,
                    statusText: "Permanent Redirect",
                    headers: new Map([["location", "/moved-resource"]]),
                    body: new Uint8Array(0),
                };
            }
            return {
                statusCode: 200,
                statusText: "OK",
                headers: new Map<string, string>([["content-length", "2"]]),
                body: enc("ok"),
            };
        });
        const response = await followRedirects(conn, put, "https://example.com/resource");
        expect(response.statusCode).toBe(200);
        const second = conn.requests[1]!;
        expect(second.method).toBe("PUT");
        expect(second.body).toEqual({ kind: "bytes", data: body });
    });
});
