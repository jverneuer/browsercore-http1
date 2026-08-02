# @browsercore/http1 — Implementation Plan

HTTP/1.1 client over any duplex byte stream. Implement in this order; each step
is independently testable.

## Step 1 — Request serialization (DONE)

`serializeRequest()` is implemented and tested. Produces `request-line CRLF
headers CRLF body` per RFC 7230. The body is appended verbatim — chunking and
content-length are the caller's concern.

Tests: a simple GET produces the expected wire bytes; a POST with headers and
a body appends the body after the blank line.

## Step 2 — Response parsing

`parseResponse()` is implemented and tested. Splits headers from body, parses
the status line, lower-cases header names, respects `content-length` for body
extraction. Returns bytes consumed for keep-alive buffer draining.

Tests: parse a raw response string; reject garbage with `InvalidResponseError`.

## Step 3 — Chunked transfer decoding

Implement `parseChunkedEncoding()`: parse the hex chunk-size framing, yield
decoded bytes, handle trailers. Raise `ChunkEncodingError` on malformed input.

Tests: feed a known chunked body; assert decoded bytes match. Feed truncated
input; assert `ChunkEncodingError` fires.

## Step 4 — Content-encoding decompression

Support `gzip`, `deflate`, and `br` (brotli) content-encodings. Decompress the
body after chunked decoding but before returning to the caller.

Tests: encode a payload with each algorithm, mark it with the matching header,
and assert the parsed response body matches the original.

## Step 5 — Keep-alive + connection reuse

Implement `Http1ConnectionImpl.request()`: serialize, write to the transport,
parse the response, drain the buffer by `bytesConsumed`. Serial requests on a
single connection — HTTP/1.1 has no multiplexing. Honor `Connection: close`.

Tests: send multiple requests on one connection; assert each gets the right
response. Assert the connection closes cleanly on `Connection: close`.

## Step 6 — Redirect following

Handle 3xx responses: follow `Location` headers up to `maxRedirects`, rewrite
the method/body per RFC 7231, raise `RedirectLimitError` when the limit is hit.

Tests: a 301 chain of 2 redirects resolves to the final URL. A chain longer
than `maxRedirects` raises `RedirectLimitError` with the trail.

## Step 7 — Cookie header integration seam

Provide a hook (callback or middleware slot) where `@browsercore/cookies` can inject
`Cookie` headers into outgoing requests and read `Set-Cookie` headers from
responses. This package does NOT implement cookie storage — only the seam.

Tests: a request passing through the seam has its `Cookie` header set; a
response passing through the seam has its `Set-Cookie` recorded.

## Definition of done

- [x] Request serialization produces RFC 7230 wire bytes.
- [x] Response parsing handles status, headers, and content-length body.
- [x] Chunked transfer-encoding decodes correctly.
- [x] gzip / deflate / brotli decompression works.
- [ ] Keep-alive serializes multiple requests over one connection. — test pending (keep-alive-multi-request)
- [ ] Redirects follow up to `maxRedirects`; loops are detected. — test pending (Connection:close)
- [x] Cookie seam is pluggable without owning cookie storage.
- [x] Every test in `tests/` passes; `tsc --build` is clean.
