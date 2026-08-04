# @browsercore/http1

[![npm version](https://img.shields.io/npm/v/@browsercore/http1)](https://www.npmjs.com/package/@browsercore/http1)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/jverneuer/browsercore-http1/main/coverage/badge.json)](https://github.com/jverneuer/browsercore-http1/blob/main/COVERAGE.md)
[![lint](https://img.shields.io/github/actions/workflow/status/jverneuer/browsercore-http1/ci.yml?label=lint)](https://github.com/jverneuer/browsercore-http1/actions/workflows/ci.yml)

An HTTP/1.1 client over any duplex byte stream. Serializes requests, parses
responses, and manages the HTTP/1.1 protocol state machine — keep-alive, chunked
transfer-encoding, content-encoding decompression, a standalone redirect-following
helper, and a cookie-header integration seam. Knows nothing about the underlying
transport; higher layers (`@browsercore/fetch`, `@browsercore/cookies`) compose
exclusively through its exports.

## Install

```sh
npm install @browsercore/http1
```

## Quick usage

```ts
import { connectHttp1, RedirectLimitError } from "@browsercore/http1";

const conn = await connectHttp1({ transport });
try {
    const res = await conn.request({
        method: "GET",
        url: "/index.html",
        headers: new Map([["host", "example.com"]]),
        body: { kind: "empty" },
    });
    console.log(res.statusCode, res.body);
} finally {
    await conn.close();
}
```

## Public API

| Export | Kind | Purpose |
| --- | --- | --- |
| `connectHttp1()` | function | Wrap a transport with the HTTP/1.1 protocol |
| `Http1ConnectionImpl` | class | Concrete connection (serial request/response) |
| `Http1Connection` | interface | Public contract higher layers depend on |
| `HttpRequest` | interface | Serializable request |
| `HttpResponse` | interface | Parsed response |
| `HttpMethod` | literal union | Supported HTTP methods |
| `HttpBodyKind` | discriminated union | `empty` / `bytes` body |
| `Http1ConnectionState` | discriminated union | `idle \| in_flight \| closing \| closed` |
| `Http1CloseReason` | discriminated union | Why a connection closed |
| `Http1ConnectionId` | branded type | Opaque connection identifier |
| `Http1Options` | interface | Options for `connectHttp1()` |
| `CookieInterceptor` | interface | Cookie-jar integration seam |
| `CookieUrl` | interface | Subset of URL info a cookie interceptor needs |
| `serializeRequest()` | function | Request → wire bytes |
| `parseResponse()` | function | Wire bytes → response + bytes consumed |
| `ParseResponseResult` | interface | Parse result including `bytesConsumed` |
| `Headers` | type | Case-insensitive header map |
| `StartLine` | type | Request/status start-line |
| `parseChunkedEncoding()` | function | Decode a chunked body stream |
| `decompressBody()` | function | Decode a `content-encoding` body |
| `isSupportedContentEncoding()` | function | Whether a content-encoding token is decodable |
| `ContentEncoding` | literal union | `gzip \| deflate \| br` |
| `followRedirects()` | function | Standalone redirect-following helper (not auto-wired) |
| `isRedirectStatus()` | function | Whether a status code is a redirect |
| `resolveRedirectUrl()` | function | Resolve a `Location` header against a base URL |
| `RedirectStatusCode` | literal union | Status codes that trigger redirects |
| `FollowRedirectsOptions` | interface | Options for `followRedirects()` |
| `assertNever()` | function | Exhaustiveness check for discriminated unions |
| `Http1Error` | class | Base typed error |
| `RedirectLimitError` | class | Redirect chain exceeded |
| `InvalidResponseError` | class | Unparseable response bytes |
| `ContentEncodingError` | class | Unsupported/corrupt content-encoding |
| `ChunkEncodingError` | class | Malformed chunked encoding |

## Dependency graph

```
@browsercore/http1
  └─ @browsercore/compression
  └─ @browsercore/transport
        └─ node:net / node:dns / node:crypto
```

`@browsercore/compression` wraps `node:zlib`; `@browsercore/http1` calls it
never `node:zlib` directly.

Build, lint, and test config live in
[`@browsercore/dev`](https://www.npmjs.com/package/@browsercore/dev) (a
devDependency) and are re-used across every `@browsercore/*` package — see
[Development](#development).

## Development

This package shares its tooling config with the rest of the `@browsercore/*`
family through
[`@browsercore/dev`](https://www.npmjs.com/package/@browsercore/dev):

- `tsconfig.json` extends `@browsercore/dev/tsconfig.base.json`.
- `vitest.config.ts` is a one-line `definePackageConfig({ name: "http1" })`.
- `oxlint.config.ts` extends the shared base via `@browsercore/dev/oxlint`.

```sh
npm install
npm run typecheck    # tsc --noEmit
npm run lint         # oxlint --type-aware src/
npm test             # vitest run
npm run build        # tsc -p tsconfig.build.json (emit to dist/)
```

Run a **single test** with vitest's file filter:

```sh
npx vitest run tests/connection.test.ts
```

### Lint note — `await` in loops

The shared oxlint base keeps `no-await-in-loop` strict. Two loops in this
package are sequential by specification, so they carry an inline
`// eslint-disable-next-line no-await-in-loop` with a reason comment rather
than relaxing the rule globally:

- `src/connection.ts` (`readResponse`) — the transport read loop; each chunk
  must be read from the transport before the next can arrive.
- `src/redirect.ts` (`followRedirects`) — the redirect loop; each hop depends
  on the previous response's `Location` header.

Lint targets `src/` only; tests are excluded.

## License

MIT
