# @browsercore/http1


[![npm version](https://img.shields.io/npm/v/@browsercore/http1)](https://www.npmjs.com/package/@browsercore/http1)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/jverneuer/browsercore-http1/main/coverage/badge.json)](https://github.com/jverneuer/browsercore-http1/blob/main/COVERAGE.md)
[![lint](https://img.shields.io/github/actions/workflow/status/jverneuer/browsercore-http1/ci.yml?label=lint)](https://github.com/jverneuer/browsercore-http1/actions/workflows/ci.yml)

An HTTP/1.1 client over any duplex byte stream.

## Responsibility

Serialize requests, parse responses, and manage the HTTP/1.1 protocol state
machine: keep-alive, chunked transfer-encoding, content-encoding compression,
redirect following, and a cookie-header integration seam. The package knows
nothing about the underlying transport — it could be plain TCP, TLS, a pipe, or
a test double.

## What it does NOT know about

- TLS / DTLS
- TCP, DNS, or sockets
- HTTP/2 or HTTP/3
- Browser fingerprints

## Public API

```ts
import { connectHttp1, RedirectLimitError } from "@browsercore/http1";

const conn = await connectHttp1({ transport });
const res = await conn.request({
    method: "GET",
    url: "/index.html",
    headers: new Map([["host", "example.com"]]),
    body: { kind: "empty" },
});

console.log(res.statusCode, res.body);
await conn.close();
```

## Types

| Export | Kind | Purpose |
| --- | --- | --- |
| `Http1Connection` | interface | Public contract higher layers depend on |
| `connectHttp1()` | function | Wrap a transport with HTTP/1.1 |
| `HttpRequest` | interface | Serializable request |
| `HttpResponse` | interface | Parsed response |
| `HttpBodyKind` | discriminated union | Empty / bytes / streaming body |
| `Http1ConnectionState` | discriminated union | `idle \| in_flight \| closing \| closed` |
| `Http1Error` | class | Base typed error |
| `RedirectLimitError` | class | Redirect chain exceeded |
| `InvalidResponseError` | class | Unparseable response bytes |
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
