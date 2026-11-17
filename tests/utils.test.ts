import { describe, expect, it } from "vitest";
import {
    assertNever,
    createId,
    createDeferred,
    consumeTrailers,
    decodeAscii,
} from "../src/utils.js";
import { systemClock } from "../src/types.js";
import { createRandomSource } from "@browsercore/transport";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("decodeAscii", () => {
    it("decodes an ASCII byte range to a string", () => {
        expect(decodeAscii(enc("ABC"), 0, 3)).toBe("ABC");
    });

    it("decodes a sub-range", () => {
        expect(decodeAscii(enc("ABCDEF"), 1, 4)).toBe("BCD");
    });

    it("returns an empty string for a zero-length range", () => {
        expect(decodeAscii(enc("ABC"), 1, 1)).toBe("");
    });

    it("throws when end is past the buffer length", () => {
        // The explicit bounds check surfaces a corrupt offset instead of
        // silently truncating the result (Uint8Array returns undefined OOB).
        expect(() => decodeAscii(enc("ABC"), 0, 5)).toThrow(/index out of bounds/);
    });

    it("throws when start is past the buffer length", () => {
        expect(() => decodeAscii(enc("ABC"), 10, 12)).toThrow(/index out of bounds/);
    });
});

describe("consumeTrailers", () => {
    it("returns the offset past an immediate blank line (no trailers)", () => {
        // A blank line at `start` is two consecutive CRLFs — the end marker.
        expect(consumeTrailers(enc("\r\n"), 0)).toBe(2);
    });

    it("skips trailer lines and stops past the blank line", () => {
        const buf = enc("x-trailer: v\r\ny: z\r\n\r\n");
        // The terminating blank line is the final "\r\n".
        expect(consumeTrailers(buf, 0)).toBe(buf.length);
    });

    it("returns -1 when the trailer section has no terminating blank line", () => {
        expect(consumeTrailers(enc("x-trailer: v"), 0)).toBe(-1);
    });

    it("returns -1 when only a partial CRLF is present at the tail", () => {
        // Header line + a lone CR — not a blank line.
        expect(consumeTrailers(enc("x-trailer: v\r"), 0)).toBe(-1);
    });
});

describe("createDeferred", () => {
    it("resolves with the provided value", async () => {
        const d = createDeferred<number>();
        d.resolve(7);
        expect(await d.promise).toBe(7);
    });

    it("rejects with the provided reason", async () => {
        const d = createDeferred<string>();
        d.reject(new Error("nope"));
        await expect(d.promise).rejects.toThrow("nope");
    });
});

describe("createId", () => {
    it("generates a branded id prefixed with the given token", () => {
        const id = createId("http1", createRandomSource());
        expect(typeof id).toBe("string");
        expect(id.startsWith("http1_")).toBe(true);
    });

    it("produces distinct ids across calls", () => {
        // Randomness + timestamp should never collide in practice.
        expect(createId("x", createRandomSource())).not.toBe(createId("x", createRandomSource()));
    });

    it("handles short random bytes without throwing (noUncheckedIndexedAccess guard)", () => {
        // createId accesses bytes[0], [1], [2] with ?? 0 fallbacks.
        // A random source returning fewer than 3 bytes exercises those guards.
        const shortRandom = {
            randomBytes: (n: number) => new Uint8Array(Math.max(0, n - 2)),
        };
        const id = createId("test", shortRandom);
        expect(id.startsWith("test_")).toBe(true);
    });
});

describe("assertNever", () => {
    it("throws describing the unexpected value", () => {
        expect(() => assertNever("surprise" as never)).toThrow(/Unexpected value/);
    });
});

describe("systemClock (canonical Clock default)", () => {
    // The default clock implements the FULL canonical Clock from
    // @browsercore/contracts — not just the now() subset http1 reads. These
    // tests pin the timer surface so the contract cannot silently rot.
    it("now() is wall-clock epoch ms comparable with Date.now()", () => {
        const before = Date.now();
        const now = systemClock.now();
        expect(now).toBeGreaterThanOrEqual(before);
        expect(now).toBeLessThanOrEqual(Date.now());
    });

    it("monotonic() never goes backwards", () => {
        const first = systemClock.monotonic();
        const second = systemClock.monotonic();
        expect(second).toBeGreaterThanOrEqual(first);
    });

    it("sleep(ms) resolves no earlier than the delay", async () => {
        const start = systemClock.monotonic();
        await systemClock.sleep(5);
        // 1ms slack for timer granularity — the point is "not instant".
        expect(systemClock.monotonic() - start).toBeGreaterThanOrEqual(4);
    });

    it("setTimeout(ms, fn) fires once after the delay; clearTimeout cancels", async () => {
        let fired = false;
        systemClock.setTimeout(5, () => { fired = true; });
        await systemClock.sleep(15);
        expect(fired).toBe(true);

        let cancelled = false;
        const handle = systemClock.setTimeout(60_000, () => { cancelled = true; });
        systemClock.clearTimeout(handle);
        await systemClock.sleep(10);
        expect(cancelled).toBe(false);
    });
});
