import { describe, expect, it } from "vitest";
import { FakeTransportBase } from "./test-helpers.js";
import { compression } from "@browsercore/compression";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { connectHttp1 } from "../src/connection.js";
import type { HttpRequest } from "../src/types.js";

/**
 * A fake in-memory transport that answers each write with a queued response.
 * Composes an injected EventProvider (via FakeTransportBase) rather than
 * extending node:events — matches the production Transport pattern.
 */
class FakeTransport extends FakeTransportBase {
    private readonly responses: Uint8Array[] = [];

    public queueResponse(bytes: Uint8Array): void {
        this.responses.push(bytes);
    }

    public async write(data: Uint8Array): Promise<void> {
        void data;
        const next = this.responses.shift();
        if (next !== undefined) {
            queueMicrotask(() => this.events.emit("data", next));
        }
    }
}

function enc(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

describe("Http1Connection body decoding", () => {
    it("decompresses a gzip content-encoding body", async () => {
        const payload = "hello gzip world ".repeat(10);
        const body = new Uint8Array(gzipSync(enc(payload)));
        const headerLines = [
            "HTTP/1.1 200 OK",
            "content-encoding: gzip",
            `content-length: ${body.length}`,
            "content-type: text/plain",
            "",
            "",
        ];
        const wire = new Uint8Array([...enc(headerLines.join("\r\n")), ...body]);

        const transport = new FakeTransport();
        transport.queueResponse(wire);
        const conn = await connectHttp1({ transport, decompressionProvider: compression });
        const response = await conn.request({
            method: "GET",
            url: "/",
            headers: new Map([["host", "example.com"]]),
            body: { kind: "empty" },
        });
        await conn.close();
        expect(response.statusCode).toBe(200);
        expect(response.headers.get("content-encoding")).toBe("gzip");
        expect(new TextDecoder().decode(response.body)).toBe(payload);
    });

    it("decompresses a brotli content-encoding body", async () => {
        const payload = "hello brotli ".repeat(10);
        const body = new Uint8Array(brotliCompressSync(enc(payload)));
        const headerLines = [
            "HTTP/1.1 200 OK",
            "content-encoding: br",
            `content-length: ${body.length}`,
            "",
            "",
        ];
        const wire = new Uint8Array([...enc(headerLines.join("\r\n")), ...body]);

        const transport = new FakeTransport();
        transport.queueResponse(wire);
        const conn = await connectHttp1({ transport, decompressionProvider: compression });
        const response = await conn.request({
            method: "GET",
            url: "/",
            headers: new Map([["host", "example.com"]]),
            body: { kind: "empty" },
        });
        await conn.close();
        expect(new TextDecoder().decode(response.body)).toBe(payload);
    });

    it("decodes a chunked transfer-encoding body", async () => {
        const part1 = "foo";
        const part2 = "barbaz";
        const wire = enc(`HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n${part1.length.toString(16)}\r\n${part1}\r\n${part2.length.toString(16)}\r\n${part2}\r\n0\r\n\r\n`);

        const transport = new FakeTransport();
        transport.queueResponse(wire);
        const conn = await connectHttp1({ transport, decompressionProvider: compression });
        const response = await conn.request({
            method: "GET",
            url: "/",
            headers: new Map([["host", "example.com"]]),
            body: { kind: "empty" },
        });
        await conn.close();
        expect(response.statusCode).toBe(200);
        expect(response.headers.get("transfer-encoding")).toBe("chunked");
        expect(new TextDecoder().decode(response.body)).toBe("foobarbaz");
    });

    it("decodes chunked then decompresses (transfer-encoding outer)", async () => {
        const payload = "compressed chunked body ".repeat(8);
        const body = new Uint8Array(gzipSync(enc(payload)));
        // Body is binary; build the wire by concatenation rather than string framing.
        const header = enc("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\ncontent-encoding: gzip\r\n\r\n");
        const sizeLine = enc(`${body.length.toString(16)}\r\n`);
        const endMarkers = enc("\r\n0\r\n\r\n");
        const wire = new Uint8Array([...header, ...sizeLine, ...body, ...endMarkers]);

        const transport = new FakeTransport();
        transport.queueResponse(wire);
        const conn = await connectHttp1({ transport, decompressionProvider: compression });
        const response = await conn.request({
            method: "GET",
            url: "/",
            headers: new Map([["host", "example.com"]]),
            body: { kind: "empty" },
        });
        await conn.close();
        expect(new TextDecoder().decode(response.body)).toBe(payload);
    });
});
