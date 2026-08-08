/**
 * Shared test helpers for http1 tests — an in-memory EventProvider mock.
 *
 * Like the transport package, @browsercore/http1 provides NO fallback
 * EventProvider; every test must inject one. This module provides:
 * - `createMockEventProvider()` — an in-memory EventProvider mock that stands
 *   in for the Node EventEmitter-backed provider browsersmith injects in prod.
 * - `FakeTransportBase` — base class that implements the Transport event
 *   surface via composition over an injected EventProvider, so test
 *   subclasses stay focused on the transport behavior being tested.
 */

import type { EventProvider } from "@browsercore/contracts";
import type { Transport } from "@browsercore/transport";

/**
 * Create a minimal in-memory EventProvider. Stand-in for the Node
 * EventEmitter-backed provider that browsersmith injects in production.
 *
 * @returns A fresh EventProvider backed by an in-memory listener map.
 */
export function createMockEventProvider(): EventProvider {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    return {
        on(event, listener) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(listener);
        },
        once(event, listener) {
            const wrapped = (...args: unknown[]) => {
                listeners.get(event)?.delete(wrapped);
                listener(...args);
            };
            this.on(event, wrapped);
        },
        off(event, listener) {
            listeners.get(event)?.delete(listener);
        },
        removeListener(event, listener) {
            listeners.get(event)?.delete(listener);
        },
        emit(event, ...args) {
            const set = listeners.get(event);
            if (!set || set.size === 0) return false;
            for (const l of [...set]) l(...args);
            return true;
        },
        listenerCount(event) {
            return listeners.get(event)?.size ?? 0;
        },
        removeAllListeners(event) {
            if (event) listeners.delete(event);
            else listeners.clear();
        },
    };
}

/**
 * Base for fake transports used in http1 tests.
 *
 * Implements the Transport event surface (on/once/off/removeListener/emit/
 * listenerCount/removeAllListeners) by delegating to an injected
 * EventProvider — composition rather than inheritance, matching the
 * production Transport pattern. Subclasses provide their own write/read/close
 * behavior and emit events via `this.events.emit(...)`.
 *
 * Extends nothing — the event surface is satisfied entirely through
 * delegation, keeping the fake free of any coupling to `node:events`.
 */
export class FakeTransportBase implements Transport {
    public readonly id: Transport["id"];
    public state: Transport["state"] = { state: "open" };

    /** Injected EventProvider backend — tests emit events through it. */
    protected readonly events: EventProvider = createMockEventProvider();

    constructor(id = "fake") {
        this.id = id as Transport["id"];
    }

    // -------------------------------------------------------------------------
    // EventProvider delegation — decouples the fake from node:events.
    // -------------------------------------------------------------------------

    public on(event: string, listener: (...args: unknown[]) => void): void {
        this.events.on(event, listener);
    }

    public once(event: string, listener: (...args: unknown[]) => void): void {
        this.events.once(event, listener);
    }

    public off(event: string, listener: (...args: unknown[]) => void): void {
        this.events.off(event, listener);
    }

    public removeListener(event: string, listener: (...args: unknown[]) => void): void {
        this.events.removeListener(event, listener);
    }

    public emit(event: string, ...args: unknown[]): boolean {
        return this.events.emit(event, ...args);
    }

    public listenerCount(event: string): number {
        return this.events.listenerCount(event);
    }

    public removeAllListeners(event?: string): void {
        this.events.removeAllListeners(event);
    }

    // -------------------------------------------------------------------------
    // Transport methods — subclasses override with their own behavior.
    // -------------------------------------------------------------------------

    public async write(_data: Uint8Array): Promise<void> {}

    public read(): Promise<Uint8Array> {
        return Promise.resolve(new Uint8Array(0));
    }

    public async close(): Promise<void> {
        this.state = { state: "closed", reason: { kind: "client_close" } };
        this.events.emit("close", false);
    }
}
