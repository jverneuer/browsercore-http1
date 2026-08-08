# @browsercore/http1

[![npm version](https://img.shields.io/npm/v/@browsercore/http1)](https://www.npmjs.com/package/@browsercore/http1)
[![coverage](https://img.shields.io/endpoint?url=https://jverneuer.github.io/browsercore-http1/badge.json)](https://github.com/jverneuer/browsercore-http1/blob/main/COVERAGE.md)
[![lint](https://img.shields.io/github/actions/workflow/status/jverneuer/browsercore-http1/ci.yml?label=lint)](https://github.com/jverneuer/browsercore-http1/actions/workflows/ci.yml)

An HTTP/1.1 client over any duplex byte stream. Serializes requests, parses
responses, and manages the HTTP/1.1 protocol state machine — keep-alive, chunked
transfer-encoding, content-encoding decompression, redirect following, and a
cookie-header integration seam. Knows nothing about the underlying transport;
higher layers (`@browsercore/fetch`, `@browsercore/cookies`) compose
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
| `Http1Connection` | interface | Public contract higher layers depend on |
| `Http1ConnectionImpl` | class | Concrete connection (serial request/response) |
| `HttpRequest` | interface | Serializable request |
| `HttpResponse` | interface | Parsed response |
| `HttpBodyKind` | discriminated union | `empty` / `bytes` body |
| `HttpMethod` | literal union | Supported HTTP methods |
| `Http1ConnectionState` | discriminated union | `idle \| in_flight \| closing \| closed` |
| `Http1CloseReason` | discriminated union | Why a connection closed |
| `Http1Options` | interface | Options for `connectHttp1()` |
| `CookieInterceptor` | interface | Cookie-jar integration seam |
| `serializeRequest()` | function | Request → wire bytes |
| `parseResponse()` | function | Wire bytes → response + bytes consumed |
| `parseChunkedEncoding()` | function | Decode a chunked body stream |
| `decompressBody()` | function | Decode a `content-encoding` body |
| `followRedirects()` | function | Standalone redirect-following helper |
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
never `node:zlib` directly. `@browsercore/http1` does NOT import `node:events`
— event emission is composed exclusively through the injected `EventProvider`
on the `Transport` it consumes (browsersmith is the composition root that
provides the runtime backend).

## Position in BrowserCore

```
Application
      │
   @browsercore/http1
      │
   @browsercore/tls
      │
@browsercore/transport
      │
     TCP
```

Every higher networking layer communicates with the network exclusively through the layers below it.

## License

MIT
