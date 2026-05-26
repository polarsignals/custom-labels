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

   - offset `0`, size `sizeof(void *)` — `cped_slot`, a pointer to the V8
     isolate's `ContinuationPreservedEmbedderData` slot. The slot holds a
     `v8::internal::Address` (a `uintptr_t`-sized tagged V8 word).
     Dereferencing it yields the current `AsyncContextFrame` value, which
     V8 updates live as it switches between continuations. Lets the reader
     skip the V8-internal-symbol lookup that would otherwise be needed to
     find the current isolate.
   - offset `sizeof(void *)`, size `sizeof(void *)` — `als_handle`, a
     `v8::Global<v8::Object>` referring to the `AsyncLocalStorage`
     instance the writer uses. Its underlying representation is a single
     V8 internal pointer.
   - offset `2 * sizeof(void *)`, size `sizeof(int)` — `als_identity_hash`,
     the JS identity hash of that ALS instance. Useful for narrowing the
     search to a single hash bucket inside the `AsyncContextFrame`'s map.

  All three fields are fixed for a particular V8 isolate once computed.
  Since the Node.js model is to associate an isolate with a thread in a 1:1
  fashion, this also means that the values for a particular thread are fixed
  for the lifetime of the thread and can be cached by a reader.

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

A reader detecting this schema can find the current thread context record using
an algorithm that encodes knowledge of the relevant objects in V8 working
memory. It first needs to dereference the tagged pointer at `cped_slot`. (V8
tagged pointers have their lowest bit set, it needs to be zeroed out for proper
dereferencing.) That yields the address of the AsyncContextFrame object, which
is a V8 JSMap. It will have a tagged pointer to its V8 OrderedHashMap at offset
(3 * uintptr_t). Following it yields the said map, which is a subclass of V8
FixedArray, a fixed-size array of uintptr_t slots. Its element 1 (not 0) encodes
its own length as a V8 Smi (small integer; low 32 bits are zero, need to shift
it right by 32 bits for the actual value.) Elements 2, 3, 4 encode the number of
elements, number of deleted elements, and number of hash buckets. A naive
implementation can at this point dereference `als_handle` (also a tagged
pointer) to get the pointer to the ALS object and just scan the entire array,
looking for the same value as a hashtable key. Once found, the next entry is its
associated value, a JSObject that in its internal field 0 (at offset
(3 * uintptr_t) from the JSObject, holding the raw native pointer directly since
Node's bundled V8 has both pointer compression and the sandbox disabled) has a
pointer to the native `CtxWrap` object, which has a `record_` field pointing
to the actual thread context record. A more sophisticated implementation can use
`als_identity_hash` to identify the particular hash bucket and limit scanning of
the hashtable to only that bucket.

The above algorithm works correctly for the fortunately unchanged layouts of all
objects involved between Node.js versions 22 and 26.

A reader should validate the record (at the very least confirm it has its
`valid` field set to 1) to also ensure that this multi-step pointer chasing led
to an actual record.

## Functionality not currently in scope

* This component does not explicitly coordinate with OTEP-4719 process-context
  for either reading or updating the association of numeric key indices to their
  names.
* We're not merging attribute sets in nested `withContext` invocations, a new
  record completely replaces the previous record for the duration of the nested
  invocation.

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
