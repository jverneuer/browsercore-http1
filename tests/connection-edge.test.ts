import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Transport } from "@browsercore/transport";
import { connectHttp1 } from "../src/connection.js";
import type { HttpRequest } from "../src/types.js";

/**
 * A transport the test drives by hand — push bytes and close events on its own
 * schedule. Lets us exercise the empty-data-frame path, the cookie seam, and
 * byte-at-a-time reassembly.
 */
class ControllableTransport extends EventEmitter implements Transport {
    public readonly id = "ctrl" as Transport["id"];
    public state: Transport["state"] = { state: "open" };
    public readonly written: Uint8Array[] = [];

    public async write(data: Uint8Array): Promise<void> {
        this.written.push(data);
    }

    public read(): Promise<Uint8Array> {
        return Promise.resolve(new Uint8Array(0));
    }

    public async close(): Promise<void> {
        this.state = { state: "closed", reason: { kind: "client_close" } };
        this.emit("close", false);
    }

    /** Emit a `data` event synchronously, as a real socket would. */
    public pushData(chunk: Uint8Array): void {
        this.emit("data", chunk);
    }

    /** Emit a `close` event without going through the graceful handshake. */
    public closeRemote(): void {
        this.emit("close", false);
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

describe("cookie interceptor edge cases", () => {
    it("leaves the request unchanged when addCookies returns an empty string", async () => {
        // A bare empty string is a no-op cookie value: the connection must not
        // add a `cookie:` header with an empty value.
        const transport = new ControllableTransport();
        const conn = await connectHttp1({
            transport,
            cookieInterceptor: { addCookies: () => "" },
        });
        const pending = conn.request(getReq());
        await flush();
        transport.pushData(enc("HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n"));
        await pending;
        await conn.close();
        const wire = dec(transport.written[0]!);
        expect(wire).not.toMatch(/cookie:/i);
    });

    it("still stores response cookies when addCookies is undefined", async () => {
        // Only the store side of the seam is configured — request injection
        // must be skipped, but response Set-Cookie still captured.
        const stored: string[] = [];
        const transport = new ControllableTransport();
        const conn = await connectHttp1({
            transport,
            cookieInterceptor: {
                storeCookies: (_url, cookies) => {
                    stored.push(...cookies);
                },
            },
        });
        const pending = conn.request(getReq());
        await flush();
        transport.pushData(enc("HTTP/1.1 200 OK\r\nset-cookie: sid=1\r\ncontent-length: 0\r\n\r\n"));
        await pending;
        await conn.close();
        expect(stored).toEqual(["sid=1"]);
    });

    it("strips the port from the host header when building the cookie URL", async () => {
        const seen: string[] = [];
        const transport = new ControllableTransport();
        const conn = await connectHttp1({
            transport,
            cookieInterceptor: {
                addCookies: (url) => {
                    seen.push(url.host);
                    return "";
                },
            },
        });
        const pending = conn.request({
            method: "GET",
            url: "/",
            headers: new Map([["host", "example.com:8443"]]),
            body: { kind: "empty" as const },
        });
        await flush();
        transport.pushData(enc("HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n"));
        await pending;
        await conn.close();
        expect(seen[0]).toBe("example.com");
    });
});

describe("transport data framing edge cases", () => {
    it("ignores an empty data frame followed by the real bytes", async () => {
        // A transport may emit a zero-length data chunk (e.g. an empty read
        // completion). appendBuffer must no-op on it rather than corrupt state.
        const transport = new ControllableTransport();
        const conn = await connectHttp1({ transport });
        const pending = conn.request(getReq());
        await flush();

        transport.pushData(new Uint8Array(0));
        await flush();
        transport.pushData(enc("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"));

        const response = await pending;
        expect(dec(response.body)).toBe("ok");
        await conn.close();
    });

    it("assembles a response delivered one byte at a time", async () => {
        // Each byte arrives as its own data event — exercises the incremental
        // header scan and content-length accumulation across many appends.
        const transport = new ControllableTransport();
        const conn = await connectHttp1({ transport });
        const pending = conn.request(getReq());
        await flush();

        for (const byte of enc("HTTP/1.1 200 OK\r\ncontent-length: 3\r\n\r\nabc")) {
            transport.pushData(new Uint8Array([byte]));
            await flush();
        }

        const response = await pending;
        expect(response.statusCode).toBe(200);
        expect(dec(response.body)).toBe("abc");
        await conn.close();
    });

    it("drains a body without content-length split across close", async () => {
        // No content-length and not chunked: the body is "until close". Bytes
        // arrive, then the remote closes — the buffered bytes become the body.
        const transport = new ControllableTransport();
        const conn = await connectHttp1({ transport });
        const pending = conn.request(getReq());
        await flush();

        transport.pushData(enc("HTTP/1.1 200 OK\r\n\r\npart1-"));
        await flush();
        transport.pushData(enc("part2"));
        await flush();
        transport.pushData(new Uint8Array(0));
        await flush();
        transport.closeRemote();

        const response = await pending;
        expect(dec(response.body)).toBe("part1-part2");
        await conn.close();
    });
});
