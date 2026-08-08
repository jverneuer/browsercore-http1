import { describe, expect, it } from "vitest";
import { FakeTransportBase } from "./test-helpers.js";
import { connectHttp1 } from "../src/connection.js";
import type { HttpRequest } from "../src/types.js";

/**
 * A fake in-memory transport that answers each write with a queued response.
 * Composes an injected EventProvider (via FakeTransportBase) rather than
 * extending node:events — matches the production Transport pattern.
 */
class FakeTransport extends FakeTransportBase {
    public readonly written: Uint8Array[] = [];
    private readonly responses: Uint8Array[] = [];

    public queueResponse(bytes: Uint8Array): void {
        this.responses.push(bytes);
    }

    public async write(data: Uint8Array): Promise<void> {
        this.written.push(data);
        // Emit the next queued response asynchronously, like a real socket.
        const next = this.responses.shift();
        if (next !== undefined) {
            queueMicrotask(() => this.events.emit("data", next));
        }
    }
}

function enc(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

/** Build a raw HTTP/1.1 response with the given status + headers + body. */
function rawResponse(status: number, headers: Record<string, string>, body: string): Uint8Array {
    const lines = [`HTTP/1.1 ${status} ${status === 200 ? "OK": ""}`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    lines.push("");
    lines.push("");
    return enc(`${lines.join("\r\n")}${body}`);
}

describe("cookie interceptor seam", () => {
    it("injects a Cookie header from addCookies into the serialized request", async () => {
        const transport = new FakeTransport();
        transport.queueResponse(rawResponse(200, { "content-length": "2" }, "hi"));
        const cookies = new Map<string, string>([["session", "abc"]]);
        const seen: Array<{ host: string; path: string; protocol: string }> = [];
        const conn = await connectHttp1({
            transport,
            cookieInterceptor: {
                addCookies: (url) => {
                    seen.push(url);
                    return "session=abc";
                },
            },
        });
        const req: HttpRequest = {
            method: "GET",
            url: "/index",
            headers: new Map([["host", "example.com"]]),
            body: { kind: "empty" },
        };
        const response = await conn.request(req);
        await conn.close();
        expect(response.statusCode).toBe(200);
        // The interceptor was called with a parsed URL.
        expect(seen).toHaveLength(1);
        expect(seen[0]?.host).toBe("example.com");
        expect(seen[0]?.path).toBe("/index");
        // The serialized wire bytes carry the Cookie header.
        const wire = new TextDecoder().decode(transport.written[0]!);
        expect(wire).toContain("cookie: session=abc\r\n");
        expect(wire).toContain("GET /index HTTP/1.1");
    });

    it("records response Set-Cookie headers via storeCookies", async () => {
        const transport = new FakeTransport();
        transport.queueResponse(
            rawResponse(200, { "set-cookie": "sid=123; Path=/", "content-length": "0" }, ""),
        );
        const stored: Array<{ host: string; cookies: string[] }> = [];
        const conn = await connectHttp1({
            transport,
            cookieInterceptor: {
                storeCookies: (url, setCookies) => {
                    stored.push({ host: url.host, cookies: setCookies });
                },
            },
        });
        const req: HttpRequest = {
            method: "GET",
            url: "/private",
            headers: new Map([["host", "example.com"]]),
            body: { kind: "empty" },
        };
        await conn.request(req);
        await conn.close();
        expect(stored).toHaveLength(1);
        expect(stored[0]?.host).toBe("example.com");
        expect(stored[0]?.cookies).toEqual(["sid=123; Path=/"]);
    });

    it("injects multiple cookies when addCookies returns a Map", async () => {
        const transport = new FakeTransport();
        transport.queueResponse(rawResponse(200, { "content-length": "0" }, ""));
        const conn = await connectHttp1({
            transport,
            cookieInterceptor: {
                addCookies: () => new Map<string, string>([
                    ["session", "abc"],
                    ["csrf", "token"],
                ]),
            },
        });
        const req: HttpRequest = {
            method: "GET",
            url: "/",
            headers: new Map([["host", "example.com"]]),
            body: { kind: "empty" },
        };
        await conn.request(req);
        await conn.close();
        const wire = new TextDecoder().decode(transport.written[0]!);
        expect(wire).toContain("session: abc\r\n");
        expect(wire).toContain("csrf: token\r\n");
    });

    it("passes through unchanged when addCookies returns an empty Map", async () => {
        const transport = new FakeTransport();
        transport.queueResponse(rawResponse(200, { "content-length": "0" }, ""));
        const conn = await connectHttp1({
            transport,
            cookieInterceptor: {
                addCookies: () => new Map<string, string>(),
            },
        });
        const req: HttpRequest = {
            method: "GET",
            url: "/",
            headers: new Map([["host", "example.com"]]),
            body: { kind: "empty" },
        };
        await conn.request(req);
        await conn.close();
        const wire = new TextDecoder().decode(transport.written[0]!);
        // No cookie headers were injected.
        expect(wire).not.toContain("session");
        expect(wire).not.toContain("csrf");
    });

    it("passes through unchanged when no interceptor is configured", async () => {
        const transport = new FakeTransport();
        transport.queueResponse(rawResponse(200, { "content-length": "2" }, "ok"));
        const conn = await connectHttp1({ transport });
        const req: HttpRequest = {
            method: "GET",
            url: "/plain",
            headers: new Map([["host", "example.com"]]),
            body: { kind: "empty" },
        };
        const response = await conn.request(req);
        await conn.close();
        expect(response.statusCode).toBe(200);
        const wire = new TextDecoder().decode(transport.written[0]!);
        expect(wire).not.toContain("cookie:");
    });
});
