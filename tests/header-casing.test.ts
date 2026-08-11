import { describe, expect, it } from "vitest";
import { serializeRequest, formatHeaderName } from "../src/message.js";

const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Strip the request-line and the trailing blank line, returning header lines. */
function headerLines(text: string): string[] {
    const section = text.slice(0, text.indexOf("\r\n\r\n"));
    return section.split("\r\n").slice(1);
}

describe("formatHeaderName", () => {
    it("defaults to lowercase when no mode is supplied", () => {
        // Omitting the mode argument must behave as the canonical lowercase form
        // so existing callers that never set a casing are unaffected.
        expect(formatHeaderName("Content-Type")).toBe("content-type");
        expect(formatHeaderName("USER-AGENT")).toBe("user-agent");
    });

    it("lowercases the entire name in lowercase mode", () => {
        expect(formatHeaderName("Content-Type", "lowercase")).toBe("content-type");
        expect(formatHeaderName("X-Custom", "lowercase")).toBe("x-custom");
    });

    it("capitalizes only the first letter in title mode", () => {
        // Real browsers send mixed-case header names over HTTP/1.1; title mode
        // reproduces that surface without requiring callers to pre-case each name.
        expect(formatHeaderName("content-type", "title")).toBe("Content-type");
        expect(formatHeaderName("CONTENT-TYPE", "title")).toBe("Content-type");
        expect(formatHeaderName("uSER-aGENT", "title")).toBe("User-agent");
    });

    it("emits the name verbatim in original mode", () => {
        // The caller is fully responsible for casing — no transformation applied.
        expect(formatHeaderName("Content-Type", "original")).toBe("Content-Type");
        expect(formatHeaderName("CONTENT-TYPE", "original")).toBe("CONTENT-TYPE");
        expect(formatHeaderName("weird-CASE", "original")).toBe("weird-CASE");
    });

    it("handles an empty header name without throwing", () => {
        // An edge input: the empty string should round-trip in every mode.
        expect(formatHeaderName("", "lowercase")).toBe("");
        expect(formatHeaderName("", "title")).toBe("");
        expect(formatHeaderName("", "original")).toBe("");
    });
});

describe("serializeRequest header casing", () => {
    it("defaults to lowercase when headerCasing is omitted (backward compatible)", () => {
        // The absence of headerCasing must serialize exactly as before this
        // feature existed — every existing test and caller depends on this.
        const req = {
            method: "GET" as const,
            url: "/",
            headers: new Map([
                ["HOST", "example.com"],
                ["Accept", "*/*"],
            ]),
            body: { kind: "empty" as const },
        };
        const text = dec(serializeRequest(req));
        expect(headerLines(text)).toEqual(["host: example.com", "accept: */*"]);
    });

    it("serializes in lowercase mode explicitly", () => {
        const req = {
            method: "POST" as const,
            url: "/submit",
            headers: new Map([
                ["Content-Type", "application/json"],
                ["User-Agent", "test/1.0"],
            ]),
            body: { kind: "empty" as const },
            headerCasing: "lowercase" as const,
        };
        const text = dec(serializeRequest(req));
        expect(headerLines(text)).toEqual([
            "content-type: application/json",
            "user-agent: test/1.0",
        ]);
    });

    it("serializes in title mode for browser impersonation", () => {
        // Real browsers send Title-Case header names over HTTP/1.1. Title mode
        // capitalizes the first letter so "content-type" → "Content-type".
        const req = {
            method: "GET" as const,
            url: "/",
            headers: new Map([
                ["host", "example.com"],
                ["accept", "text/html"],
                ["user-agent", "Mozilla/5.0"],
            ]),
            body: { kind: "empty" as const },
            headerCasing: "title" as const,
        };
        const text = dec(serializeRequest(req));
        expect(headerLines(text)).toEqual([
            "Host: example.com",
            "Accept: text/html",
            "User-agent: Mozilla/5.0",
        ]);
    });

    it("preserves caller-provided casing in original mode", () => {
        // Original mode emits names exactly as stored — useful when a profile
        // supplies pre-cased names (e.g. mixed-case with hyphens).
        const req = {
            method: "GET" as const,
            url: "/",
            headers: new Map([
                ["Host", "example.com"],
                ["Accept-Encoding", "gzip, deflate"],
                ["x-CuStOm", "weird"],
            ]),
            body: { kind: "empty" as const },
            headerCasing: "original" as const,
        };
        const text = dec(serializeRequest(req));
        expect(headerLines(text)).toEqual([
            "Host: example.com",
            "Accept-Encoding: gzip, deflate",
            "x-CuStOm: weird",
        ]);
    });

    it("preserves header insertion order on the wire", () => {
        // Map iterates in insertion order — the serializer must not reorder,
        // because header ordering is itself a fingerprint signal.
        const ordered = [
            ["sec-ch-ua", '"Chromium";v="120"'],
            ["sec-ch-ua-mobile", "?0"],
            ["upgrade-insecure-requests", "1"],
            ["user-agent", "Mozilla/5.0"],
            ["accept", "text/html"],
        ] as const;
        const req = {
            method: "GET" as const,
            url: "/",
            headers: new Map(ordered),
            body: { kind: "empty" as const },
            headerCasing: "original" as const,
        };
        const text = dec(serializeRequest(req));
        // The names appear in the exact order they were inserted into the Map.
        expect(headerLines(text)).toEqual(
            [...ordered].map(([name, value]) => `${name}: ${value}`),
        );
    });

    it("round-trips title casing with a request body", () => {
        // Casing must apply regardless of whether a body is present.
        const data = new TextEncoder().encode('{"ok":true}');
        const req = {
            method: "POST" as const,
            url: "/api",
            headers: new Map([
                ["content-type", "application/json"],
                ["content-length", String(data.length)],
            ]),
            body: { kind: "bytes" as const, data },
            headerCasing: "title" as const,
        };
        const bytes = serializeRequest(req);
        const text = dec(bytes);
        expect(headerLines(text)).toEqual([
            "Content-type: application/json",
            `Content-length: ${data.length}`,
        ]);
        // Body bytes follow the header terminator unchanged.
        expect(bytes.slice(bytes.length - data.length)).toEqual(data);
    });
});
