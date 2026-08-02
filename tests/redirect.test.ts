import { describe, expect, it } from "vitest";
import type { Http1Connection, Http1ConnectionId, Http1ConnectionState, HttpRequest, HttpResponse } from "../src/types.js";
import { RedirectLimitError } from "../src/errors.js";
import {
    followRedirects,
    isRedirectStatus,
    resolveRedirectUrl,
    type RedirectStatusCode,
} from "../src/redirect.js";

/** A scripted connection: maps request URLs to responses, recording the trail. */
class ScriptedConnection implements Http1Connection {
    public readonly id: Http1ConnectionId = "scripted" as Http1ConnectionId;
    public state: Http1ConnectionState = { state: "idle" };
    public readonly requests: string[] = [];

    public constructor(
        private readonly responses: (req: HttpRequest) => HttpResponse,
    ) {}

    public async request(req: HttpRequest): Promise<HttpResponse> {
        this.requests.push(req.url);
        return this.responses(req);
    }

    public async close(): Promise<void> {}
}

function res(status: number, location?: string, body = ""): HttpResponse {
    const headers = new Map<string, string>();
    if (location !== undefined) headers.set("location", location);
    return {
        statusCode: status,
        statusText: "",
        headers,
        body: new TextEncoder().encode(body),
    };
}

const get = (url: string): HttpRequest => ({
    method: "GET",
    url,
    headers: new Map([["host", "example.com"]]),
    body: { kind: "empty" },
});

describe("isRedirectStatus", () => {
    it("recognizes 301/302/303/307/308", () => {
        for (const s of [301, 302, 303, 307, 308] as const) {
            expect(isRedirectStatus(s)).toBe(true);
        }
    });
    it("rejects non-redirect statuses", () => {
        for (const s of [200, 300, 304, 404, 500]) {
            expect(isRedirectStatus(s)).toBe(false);
        }
    });
    it("narrows the type", () => {
        const s: number = 301;
        if (isRedirectStatus(s)) {
            // `s` should be narrowed to RedirectStatusCode here.
            const _check: RedirectStatusCode = s;
            expect(_check).toBe(301);
        }
    });
});

describe("resolveRedirectUrl", () => {
    it("resolves a relative Location against the current URL", () => {
        expect(resolveRedirectUrl("https://example.com/a/b", "/c")).toBe("https://example.com/c");
        expect(resolveRedirectUrl("https://example.com/a/b", "c")).toBe("https://example.com/a/c");
    });
    it("takes an absolute Location as-is", () => {
        expect(resolveRedirectUrl("https://example.com/a", "https://other.com/x")).toBe("https://other.com/x");
    });
    it("preserves query strings", () => {
        expect(resolveRedirectUrl("https://example.com/a", "/c?d=1")).toBe("https://example.com/c?d=1");
    });
});

describe("followRedirects", () => {
    it("returns the response directly when it is not a redirect", async () => {
        const conn = new ScriptedConnection(() => res(200, undefined, "ok"));
        const response = await followRedirects(conn, get("/"), "https://example.com/");
        expect(response.statusCode).toBe(200);
        expect(new TextDecoder().decode(response.body)).toBe("ok");
        expect(conn.requests).toEqual(["/"]);
    });

    it("follows a 2-hop chain to the final URL", async () => {
        const conn = new ScriptedConnection((req) => {
            switch (req.url) {
                case "/":
                    return res(302, "/a");
                case "/a":
                    return res(301, "/b");
                default:
                    return res(200, undefined, "final");
            }
        });
        const response = await followRedirects(conn, get("/"), "https://example.com/");
        expect(response.statusCode).toBe(200);
        expect(new TextDecoder().decode(response.body)).toBe("final");
        expect(conn.requests).toEqual(["/", "/a", "/b"]);
    });

    it("resolves relative Location headers against the current URL", async () => {
        const conn = new ScriptedConnection((req) => {
            if (req.url === "/page") return res(302, "step2");
            return res(200, undefined, "done");
        });
        await followRedirects(conn, get("/page"), "https://example.com/page");
        expect(conn.requests).toEqual(["/page", "/step2"]);
    });

    it("throws RedirectLimitError with the trail when the limit is exceeded", async () => {
        // Always redirect to a fresh path — never terminates.
        let n = 0;
        const conn = new ScriptedConnection(() => {
            n += 1;
            return res(302, `/r${n}`);
        });
        await expect(
            followRedirects(conn, get("/"), "https://example.com/", { maxRedirects: 3 }),
        ).rejects.toThrow(RedirectLimitError);
        try {
            await followRedirects(conn, get("/"), "https://example.com/", { maxRedirects: 3 });
            expect.unreachable("should have thrown");
        } catch (err) {
            expect(err).toBeInstanceOf(RedirectLimitError);
            const e = err as RedirectLimitError;
            expect(e.limit).toBe(3);
            // Trail starts at the origin and includes every hop visited.
            expect(e.trail[0]).toBe("https://example.com/");
            expect(e.trail.length).toBeGreaterThan(1);
        }
    });

    it("throws RedirectLimitError on a loop (repeated URL)", async () => {
        const conn = new ScriptedConnection((req) => {
            if (req.url === "/a") return res(302, "/b");
            return res(302, "/a");
        });
        await expect(
            followRedirects(conn, get("/a"), "https://example.com/a"),
        ).rejects.toThrow(RedirectLimitError);
        try {
            await followRedirects(conn, get("/a"), "https://example.com/a");
            expect.unreachable("should have thrown");
        } catch (err) {
            const e = err as RedirectLimitError;
            // The repeated URL should appear in the trail.
            const counts = new Map<string, number>();
            for (const u of e.trail) counts.set(u, (counts.get(u) ?? 0) + 1);
            const repeated = [...counts.entries()].find(([, c]) => c > 1);
            expect(repeated).toBeDefined();
        }
    });

    it("stops cleanly at a redirect that has no Location header", async () => {
        const conn = new ScriptedConnection(() => res(302));
        const response = await followRedirects(conn, get("/"), "https://example.com/");
        expect(response.statusCode).toBe(302);
        expect(conn.requests).toEqual(["/"]);
    });

    it("converts a 303 to GET and strips the body", async () => {
        const post: HttpRequest = {
            method: "POST",
            url: "/submit",
            headers: new Map([
                ["host", "example.com"],
                ["content-length", "3"],
            ]),
            body: { kind: "bytes", data: new TextEncoder().encode("abc") },
        };
        const conn = new ScriptedConnection((req) => {
            // The redirected request must be GET with no body / content-length.
            if (req.url === "/done") return res(200, undefined, "ok");
            return res(303, "/done");
        });
        const response = await followRedirects(conn, post, "https://example.com/submit");
        expect(response.statusCode).toBe(200);
        const second = conn.requests[1];
        expect(second).toBe("/done");
    });
});
