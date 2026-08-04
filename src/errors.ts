/**
 * Typed errors for @browsercore/http1.
 *
 * Errors are part of the API — every failure mode is an explicit type so callers
 * can match on `kind` instead of parsing messages.
 */

/** Discriminated union of all HTTP/1.1 error kinds. */
export type Http1ErrorKind =
    | "Http1Error"
    | "RedirectLimitError"
    | "InvalidResponseError"
    | "ContentEncodingError"
    | "ChunkEncodingError"
    | "ConnectionClosedError"
    | "ConnectionClosingError"
    | "DecodeError";

/** Base class for all HTTP/1.1 errors. */
export class Http1Error extends Error {
    public readonly kind: Http1ErrorKind = "Http1Error";
    public override readonly cause: Error | undefined;

    constructor(message: string, options?: { cause?: Error }) {
        super(message, options);
        this.name = new.target.name;
        this.cause = options?.cause;
    }
}

/** Redirect chain exceeded {@link Http1Options.maxRedirects}. */
export class RedirectLimitError extends Http1Error {
    public override readonly kind = "RedirectLimitError" as const;
    public readonly limit: number;
    /** The URLs visited so far, in order — useful for debugging redirect loops. */
    public readonly trail: readonly string[];
    public override readonly cause: Error | undefined;

    constructor(limit: number, trail: readonly string[], options?: { cause?: Error }) {
        super(`Redirect limit of ${limit} exceeded after: ${trail.join(" → ")}`);
        this.name = "RedirectLimitError";
        this.limit = limit;
        this.trail = trail;
        this.cause = options?.cause;
    }
}

/** The remote sent bytes that could not be parsed as a valid HTTP/1.1 response. */
export class InvalidResponseError extends Http1Error {
    public override readonly kind = "InvalidResponseError" as const;
    /** The raw bytes that failed to parse — truncated to a sane length for logging. */
    public readonly rawPreview: string;
    public override readonly cause: Error | undefined;

    constructor(rawPreview: string, options?: { cause?: Error }) {
        super(`Invalid HTTP/1.1 response: ${rawPreview}`);
        this.name = "InvalidResponseError";
        this.rawPreview = rawPreview;
        this.cause = options?.cause;
    }
}

/** The response used a `content-encoding` this client cannot decode. */
export class ContentEncodingError extends Http1Error {
    public override readonly kind = "ContentEncodingError" as const;
    /** The unsupported (or corrupt) content-encoding token. */
    public readonly encoding: string;
    public override readonly cause: Error | undefined;

    constructor(encoding: string, options?: { cause?: Error }) {
        super(`Unsupported or corrupt content-encoding: ${encoding}`);
        this.name = "ContentEncodingError";
        this.encoding = encoding;
        this.cause = options?.cause;
    }
}

/** A chunked transfer-encoding body was malformed. */
export class ChunkEncodingError extends Http1Error {
    public override readonly kind = "ChunkEncodingError" as const;
    /** Byte offset in the body stream where the malformed chunk was detected. */
    public readonly offset: number;
    public override readonly cause: Error | undefined;

    constructor(offset: number, options?: { cause?: Error }) {
        super(`Malformed chunked encoding at offset ${offset}`);
        this.name = "ChunkEncodingError";
        this.offset = offset;
        this.cause = options?.cause;
    }
}

/** The transport closed before a complete response was received. */
export class ConnectionClosedError extends Http1Error {
    public override readonly kind = "ConnectionClosedError" as const;

    constructor(options?: { cause?: Error }) {
        super("transport closed before response received", options);
        this.name = "ConnectionClosedError";
    }
}

/** A new request was attempted on a connection that is closing. */
export class ConnectionClosingError extends Http1Error {
    public override readonly kind = "ConnectionClosingError" as const;

    constructor(options?: { cause?: Error }) {
        super("connection is closing — no new requests allowed", options);
        this.name = "ConnectionClosingError";
    }
}

/** A slice of bytes could not be decoded as ASCII. */
export class DecodeError extends Http1Error {
    public override readonly kind = "DecodeError" as const;
    /** The index in the buffer that was out of bounds. */
    public readonly index: number;
    public override readonly cause: Error | undefined;

    constructor(index: number, options?: { cause?: Error }) {
        super(`decodeAscii: index out of bounds at position ${index}`);
        this.name = "DecodeError";
        this.index = index;
        this.cause = options?.cause;
    }
}
