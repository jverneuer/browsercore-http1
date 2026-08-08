import { describe, expect, it } from "vitest";
import { FakeTransportBase } from "./test-helpers.js";
import { connectHttp1 } from "../src/connection.js";
import type { Http1CloseReason, HttpRequest } from "../src/types.js";

/**
 * A transport the test drives by hand — push bytes and close events on its own
 * schedule instead of answering each write with a whole response. This is what
 * lets us exercise the streaming read machinery (_readChunk, data waiters, the
 * mid-response drain path) that the auto-responding FakeTransport never touches.
 *
 * Composes an injected EventProvider (via FakeTransportBase) rather than
 * extending node:events — matches the production Transport pattern.
 */
class ControllableTransport extends FakeTransportBase {
    public readonly written: Uint8Array[] = [];

    public constructor() {
        super("ctrl");
    }

    public async write(data: Uint8Array): Promise<void> {
        this.written.push(data);
    }

    public async close(): Promise<void> {
        this.state = { state: "closed", reason: { kind: "client_close" } };
        this.events.emit("close", false);
    }

    /** Emit a `data` event synchronously, as a real socket would. */
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

/** Yield to the event loop so pending microtasks (promise continuations) drain. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const getReq = (url = "/"): HttpRequest => ({
    method: "GET",
    url,
    headers: new Map([["host", "example.com"]]),
    body: { kind: "empty" as const },
});

describe("Http1Connection streaming read", () => {
    it("delivers a response split across two data events", async () => {
        const transport = new ControllableTransport();
        const conn = await connectHttp1({ transport });
        const pending = conn.request(getReq());
        // Let the request reach the _readChunk waiter before pushing bytes.
        await flush();

        transport.pushData(enc("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 5\r\n"));
        await flush();
        transport.pushData(enc("\r\nhello"));

        const response = await pending;
        expect(response.statusCode).toBe(200);
        expect(dec(response.body)).toBe("hello");
        await conn.close();
    });

    it("decodes a chunked body split across data events", async () => {
        const transport = new ControllableTransport();
        const conn = await connectHttp1({ transport });
        const pending = conn.request(getReq());
        await flush();

        // First push: headers + a partial chunk (size line says 5, only 3 bytes).
        transport.pushData(enc("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhel"));
        await flush();
        // Second push: the rest of the chunk + terminating zero chunk.
        transport.pushData(enc("lo\r\n0\r\n\r\n"));

        const response = await pending;
        expect(response.statusCode).toBe(200);
        expect(dec(response.body)).toBe("hello");
        await conn.close();
    });

    it("waits when a chunk ends exactly at the buffer boundary", async () => {
        const transport = new ControllableTransport();
        const conn = await connectHttp1({ transport });
        const pending = conn.request(getReq());
        await flush();

        // Headers + one complete chunk ("hello", 5 bytes) + its trailing CRLF,
        // but the buffer ends right there — no terminating zero chunk yet.
        // findChunkedBodyEnd must return -1 (need more data), not over-read.
        transport.pushData(enc("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n"));
        await flush();
        // Still waiting on the zero chunk — the connection must not have resolved.
        expect(conn.state).toEqual({ state: "in_flight", pending: 1 });

        transport.pushData(enc("0\r\n\r\n"));
        const response = await pending;
        expect(response.statusCode).toBe(200);
        expect(dec(response.body)).toBe("hello");
        await conn.close();
    });

    it("handles a chunked trailer section split across data events", async () => {
        const transport = new ControllableTransport();
        const conn = await connectHttp1({ transport });
        const pending = conn.request(getReq());
        await flush();

        // First push: terminating chunk + a trailer line, but no final blank line.
        transport.pushData(enc("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n0\r\nx-trail: v\r\n"));
        await flush();
        // Second push: the closing blank line that ends the trailer section.
        transport.pushData(enc("\r\n"));

        const response = await pending;
        expect(response.statusCode).toBe(200);
        await conn.close();
    });

    it("drains a body without content-length once the transport closes", async () => {
        const transport = new ControllableTransport();
        const conn = await connectHttp1({ transport });
        const pending = conn.request(getReq());
        await flush();

        // No content-length and not chunked — body is "whatever arrives until close".
        transport.pushData(enc("HTTP/1.1 200 OK\r\n\r\nbody-here"));
        await flush();
        transport.closeRemote();

        const response = await pending;
        expect(response.statusCode).toBe(200);
        expect(dec(response.body)).toBe("body-here");
        await conn.close();
    });

    it("throws when the transport closes before any response arrives", async () => {
        const transport = new ControllableTransport();
        const conn = await connectHttp1({ transport });
        const pending = conn.request(getReq());
        await flush();

        transport.closeRemote();

        await expect(pending).rejects.toThrow(/transport closed before response received/);
        await conn.close();
    });
});

describe("Http1Connection lifecycle", () => {
    it("close() waits for an in-flight request to finish before closing", async () => {
        const transport = new ControllableTransport();
        const conn = await connectHttp1({ transport });
        const pending = conn.request(getReq());
        await flush();

        // close() sees a request in flight and must wait for it to drain.
        const closePending = conn.close();
        await flush();
        // The connection is still waiting — no response bytes yet.
        expect(conn.state.state).toBe("closing");

        transport.pushData(enc("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"));
        await flush();

        const response = await pending;
        expect(dec(response.body)).toBe("ok");
        await closePending;
        expect(conn.state.state).toBe("closed");
    });

    it("rejects a new request issued while a close is draining", async () => {
        const transport = new ControllableTransport();
        const conn = await connectHttp1({ transport });
        const pending = conn.request(getReq());
        await flush();

        const closePending = conn.close();
        await flush();
        expect(conn.state.state).toBe("closing");

        // A second request while closing must be rejected, not queued.
        await expect(conn.request(getReq())).rejects.toThrow(/closing/);

        // Let the first request finish so the close handshake completes.
        transport.pushData(enc("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"));
        await flush();
        await pending;
        await closePending;
        expect(conn.state.state).toBe("closed");
    });

    it("keeps a second request in flight and decrements the pending count", async () => {
        const transport = new ControllableTransport();
        const conn = await connectHttp1({ transport });
        const first = conn.request(getReq("/a"));
        await flush();
        // Issue a second request while the first is still reading.
        const second = conn.request(getReq("/b"));
        await flush();

        // Both waiters are queued; deliver the first response.
        transport.pushData(enc("HTTP/1.1 200 OK\r\ncontent-length: 1\r\n\r\na"));
        await flush();
        // First request completes — pending drops from 2 to 1 (in_flight, not idle).
        expect(conn.state).toEqual({ state: "in_flight", pending: 1 });

        transport.pushData(enc("HTTP/1.1 200 OK\r\ncontent-length: 1\r\n\r\nb"));
        await flush();
        expect(dec((await first).body)).toBe("a");
        expect(dec((await second).body)).toBe("b");
        expect(conn.state).toEqual({ state: "idle" });
        await conn.close();
    });

    it("describes each close reason in the rejection message", async () => {
        async function expectReason(reason: Http1CloseReason, fragment: string): Promise<void> {
            const transport = new ControllableTransport();
            const conn = await connectHttp1({ transport });
            await conn.close(reason);
            await expect(conn.request(getReq())).rejects.toThrow(fragment);
        }

        await expectReason({ kind: "remote_close" }, /remote closed/);
        await expectReason({ kind: "error", error: new Error("boom") }, /error: boom/);
        await expectReason({ kind: "redirect_jump", to: "/new" }, /redirect to \/new/);
    });

    it("assertNever fires for an unhandled state discriminant", async () => {
        const transport = new ControllableTransport();
        const conn = await connectHttp1({ transport });
        // Bypass the type system to feed _ensureOpen a state it does not handle.
        (conn as unknown as { state: unknown }).state = { state: "garbage" };
        await expect(conn.request(getReq())).rejects.toThrow(/Unexpected value/);
        await conn.close();
    });

    it("assertNever fires for an unhandled close-reason discriminant", async () => {
        const transport = new ControllableTransport();
        const conn = await connectHttp1({ transport });
        (
            conn as unknown as { state: unknown }
        ).state = { state: "closed", reason: { kind: "garbage" } };
        await expect(conn.request(getReq())).rejects.toThrow(/Unexpected value/);
        await conn.close();
    });
});
