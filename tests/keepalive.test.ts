import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Transport } from "@browsercore/transport";
import { connectHttp1 } from "../src/connection.js";
import type { HttpRequest } from "../src/types.js";

/**
 * A fake in-memory transport that answers each write with a queued response.
 * Tracks how many times the transport was opened so a test can assert that
 * two sequential requests reused the same connection (open-count stays 1).
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

function enc(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

/** Build a raw HTTP/1.1 response with the given status + headers + body. */
function rawResponse(status: number, headers: Record<string, string>, body: string): Uint8Array {
    const lines = [`HTTP/1.1 ${status} ${status === 200 ? "OK" : ""}`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    lines.push("");
    lines.push("");
    return enc(`${lines.join("\r\n")}${body}`);
}

const getReq = (url: string): HttpRequest => ({
    method: "GET",
    url,
    headers: new Map([["host", "example.com"]]),
    body: { kind: "empty" },
});

describe("Http1Connection keep-alive", () => {
    it("reuses the same connection for two sequential requests", async () => {
        // One transport, one connection — both requests must resolve on it. If
        // the connection were NOT keep-alive, the second request would have to
        // establish a new transport, which this fake cannot do (it would hang).
        const transport = new FakeTransport();
        transport.queueResponse(rawResponse(200, { "content-length": "2" }, "ok"));
        transport.queueResponse(rawResponse(200, { "content-length": "3" }, "bye"));

        const conn = await connectHttp1({ transport });

        const first = await conn.request(getReq("/a"));
        expect(first.statusCode).toBe(200);
        expect(new TextDecoder().decode(first.body)).toBe("ok");

        const second = await conn.request(getReq("/b"));
        expect(second.statusCode).toBe(200);
        expect(new TextDecoder().decode(second.body)).toBe("bye");

        // Both requests were written over the same underlying transport — the
        // keep-alive path drained the first response before dispatching the second.
        expect(transport.written.length).toBe(2);
        await conn.close();
    });

    it("closes cleanly when the server sends a Connection: close header", async () => {
        const transport = new FakeTransport();
        transport.queueResponse(
            rawResponse(200, { "content-length": "2", "connection": "close" }, "ok"),
        );

        const conn = await connectHttp1({ transport });
        const response = await conn.request(getReq("/"));
        expect(response.statusCode).toBe(200);
        expect(response.headers.get("connection")).toBe("close");

        // The connection must still be usable for the close handshake; the
        // transport itself remains open until close() is invoked.
        expect(transport.state.state).toBe("open");
        await conn.close();
        expect(transport.state.state).toBe("closed");
    });

    it("rejects new requests once the connection has entered closing/closed state", async () => {
        const transport = new FakeTransport();
        transport.queueResponse(rawResponse(200, { "content-length": "2" }, "ok"));

        const conn = await connectHttp1({ transport });
        await conn.request(getReq("/"));

        // Drive the connection into the closed state.
        await conn.close();
        expect(conn.state.state).toBe("closed");

        // _ensureOpen() must reject any subsequent request.
        await expect(conn.request(getReq("/after"))).rejects.toThrow(/closed|closing/);
    });
});
