# OpenTelemetry thread-context writer for Node.js

Node.js library for attaching [OpenTelemetry Thread Local Context Record (OTEP-4947)]
[otep-4947] to profiling stack traces at runtime. Records are propagated through
asynchronous operations and can be used to correlate profiling data with
distributed tracing, user contexts, or any other metadata.

[otep-4947]: https://github.com/open-telemetry/opentelemetry-specification/pull/4947

## Requirements

- Node.js v22 or later
- Node.js v22-v23: requires `--experimental-async-context-frame` flag
- Node.js v24+: works without additional flags
- A C++ toolchain (`node-gyp`) supporting `-mtls-dialect=gnu2` on x86_64
  (GCC ≥ 4.4 or Clang ≥ 19) — needed for the TLSDESC dialect used by the
  discovery thread-locals.
- Linux. On other platforms the package's exported functions degrade to
  no-ops that just invoke the supplied callback.

## Usage

```javascript
const { withContext, makeNamedContext } = require('@polarsignals/custom-labels');

// Trace and span IDs are raw bytes (Uint8Array of length 16 and 8). Buffer is
// acceptable as a Uint8Array subclass.
withContext(
    () => {
        // Code executed here will have the specified context record attached
        // to all CPU profiling stack traces, including any async work
        performWork();
    },
    {
        traceId: Buffer.from('4bf92f3577b34da6a3ce929d0e0e4736', 'hex'),
        spanId:  Buffer.from('00f067aa0ba902b7', 'hex'),
        // attributes is positional: index N here = uint8 key index N in the
        // wire record. Slots set to null/undefined or array holes are skipped.
        // Key names come from threadlocal.attribute_key_map (OTEP-4719) — for
        // this example, names at indexes 0 and 1 would be e.g. "http.method"
        // and "http.route".
        attributes: ['GET', '/api/v1/widgets'],
    },
);
```

If the caller maintains a stable list of attribute names — the same list
published in the process context — `makeNamedContext` provides a name-based
sugar API:

```javascript
const keys = [
    'http.method', // index 0
    'http.route',  // index 1
];
const withNamedContext = makeNamedContext(keys);

withNamedContext(
    () => handleRequest(),
    {
        traceId: Buffer.from('4bf92f3577b34da6a3ce929d0e0e4736', 'hex'),
        spanId:  Buffer.from('00f067aa0ba902b7', 'hex'),
        namedAttributes: {
            'http.method': 'GET',
            'http.route':  '/api/v1/widgets',
        },
    },
);
```

## API

### `withContext(callback, opts)`

Executes the callback function with the specified OTEP-4947 thread-context record attached to it. The record is automatically propagated through asynchronous operations spawned by the callback. The record is freed when no longer referenced.

**Parameters:**
- `callback` - Function to execute with context record attached
- `opts`:
  - `traceId` — 16 raw bytes (`Uint8Array`; `Buffer` works as a subclass).
  - `spanId` — 8 raw bytes (`Uint8Array`; `Buffer` works as a subclass).
  - `attributes` (optional) — positional `Array<string | null | undefined>`:
    index N is the value for uint8 key index N on the wire. Slots that are
    `null`, `undefined`, or array holes are skipped. Non-string values are
    coerced via `toString`. Values longer than 255 UTF-8 bytes are silently
    truncated; attributes that would overflow the 612-byte payload budget are
    silently dropped. Array length must not exceed 256.

**Synchronous callback:**
```javascript
withContext(
    () => {
        // Synchronous work will be associated with context record
        processDataSync();
    },
    {
        traceId: Buffer.from('4bf92f3577b34da6a3ce929d0e0e4736', 'hex'),
        spanId:  Buffer.from('00f067aa0ba902b7', 'hex'),
        attributes: ['GET', '/api/v1/widgets'],
    },
);
```

**Async callback:**
```javascript
await withContext(
    async () => {
        // Both synchronous and asynchronous work will be associated with context record
        await processRequest();
    },
    {
        traceId: Buffer.from('4bf92f3577b34da6a3ce929d0e0e4736', 'hex'),
        spanId:  Buffer.from('00f067aa0ba902b7', 'hex'),
        attributes: ['GET', '/api/v1/widgets'],
    },
);
```

When passing an async function, `withContext` returns a Promise that must be awaited. When passing a synchronous function, it executes immediately and returns the function's result.

### `makeNamedContext(keys)`

Returns `(fn, opts) => fn-result` — a name-addressed variant of `withContext`.
The `keys` array is the same string list the caller publishes (or has published)
as the `threadlocal.attribute_key_map` resource attribute in the OTEP-4719
process context: index N in `keys` is uint8 key index N on the wire. The mapping
is captured once at factory time.

`opts.namedAttributes` accepts a `Record<string,unknown>`, a `Map`, or an
`Array<[string,unknown]>`. Unknown names throw.

## Discovery contract (for reader implementers)

The writer publishes three things the reader needs to find:

1. A single thread-local symbol `otel_thread_ctx_nodejs_v1` in the addon
   shared library's `dynsym` table, emitted with the TLSDESC dialect. It
   is a struct with the following layout:

   - offset `0`, size `sizeof(void *)` — `als_handle`, a
     `v8::Global<v8::Object>` referring to the `AsyncLocalStorage`
     instance the writer uses. Its underlying representation is a single
     V8 internal pointer.
   - offset `sizeof(void *)`, size `sizeof(int)` — `als_identity_hash`,
     the JS identity hash of that ALS instance. Useful for narrowing the
     search to a single hash bucket inside the `AsyncContextFrame`'s map.

2. A JavaScript wrapper object (class name `CtxWrap`) stored as the value
   for the ALS instance key inside the current `AsyncContextFrame` (itself
   the V8 isolate's `ContinuationPreservedEmbedderData`). The wrapper is a
   `node::ObjectWrap` subclass with a single non-inherited field:

   - `OtelThreadCtxRecord *record_` — pointer to the 640-byte record,
     placed immediately after the `node::ObjectWrap` base subobject.

3. The record itself is exactly the OTEP-4947 layout: `trace_id[16]`,
   `span_id[8]`, `valid` (always 1, set during construction), `reserved`,
   `attrs_data_size` (uint16), `attrs_data[612]`.

The process-context schema version corresponding to this writer is
`nodejs_v1` (to be set in `threadlocal.schema_version` of the OTEP-4719
process context, by whichever component the application uses to publish
process context).

## Functionality not currently in scope

* This component does not explicitly coordinate with OTEP-4719 process-context
  for either reading or updating the association of numeric key indices to their
  names.
* Matching the `libdd-otel-thread-ctx` semantics, we're currently not merging
  attribute sets in nested `withContext` invocations, a new record completely
  replaces the previous record for the duration of the nested invocation.

## Development

The package's source is plain Node + a small native addon, but the addon and
its test suite are Linux-only. On macOS, run the tests inside a Linux
container:

```
npm run test:docker
```

This builds (cached) the image defined in `test/Dockerfile` and runs
`npm install` + `npm test` against the current working tree inside it. The
working tree is mounted read-only and copied to a scratch dir inside the
container, so no `node_modules/` or `build/` ever lands on the host.

## License

Apache-2.0
