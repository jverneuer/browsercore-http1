/**
 * Typed errors for @browsercore/http1.
 *
 * Errors are part of the API — every failure mode is an explicit type so callers
 * can match on `kind` instead of parsing messages.
 */

/** Base class for all HTTP/1.1 errors. */
export class Http1Error extends Error {
    public readonly kind = "Http1Error" as const;
    public override readonly cause: Error | undefined;

    constructor(message: string, options?: { cause?: Error }) {
        super(message, options);
        this.name = new.target.name;
        this.cause = options?.cause;
    }
}

/** Redirect chain exceeded {@link Http1Options.maxRedirects}. */
export class RedirectLimitError extends Error {
    public readonly kind = "RedirectLimitError" as const;
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
export class InvalidResponseError extends Error {
    public readonly kind = "InvalidResponseError" as const;
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
export class ContentEncodingError extends Error {
    public readonly kind = "ContentEncodingError" as const;
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
export class ChunkEncodingError extends Error {
    public readonly kind = "ChunkEncodingError" as const;
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
