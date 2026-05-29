# OpenTelemetry thread-context writer for Node.js

Node.js library for attaching [OpenTelemetry Thread Local Context Record (OTEP-4947)]
[otep-4947] to asynchronous contexts at runtime. Records are propagated through
asynchronous operations and can be used by external readers (such as the
OpenTelemetry eBPF profiler) to correlate current execution context (e.g. stack
traces) with distributed tracing, user contexts, or any other metadata.

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
const { runWithContext, enterWithContext, makeNamedContext } = require('@polarsignals/custom-labels');

// Trace and span IDs are raw bytes (Uint8Array of length 16 and 8). Buffer is
// acceptable as a Uint8Array subclass.
runWithContext(
    () => {
        // Code executed here will have the specified context record attached
        // to it, including any async work that follows from it.
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
const named = makeNamedContext(keys);

named.runWithContext(
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

### `runWithContext(callback, opts)`

Executes the callback function with the specified OTEP-4947 thread-context record attached to it. The record is automatically propagated through asynchronous operations spawned by the callback. The previous context (if any) is restored when the callback returns. The record is freed when no longer referenced.

**Parameters:**
- `callback` - Function to execute with context record attached
- `opts`:
  - `traceId` — 16 raw bytes (`Uint8Array`; `Buffer` works as a subclass).
  - `spanId` — 8 raw bytes (`Uint8Array`; `Buffer` works as a subclass).
  - `attributes` (optional) — positional `Array<string | null | undefined>`:
    index N is the value for uint8 key index N on the wire. Slots that are
    `null`, `undefined`, or array holes are skipped. Non-string values are
    coerced via `toString`. Individual values longer than 255 UTF-8 bytes are
    silently truncated to 255 (the on-the-wire length prefix is a uint8).
    Array length must not exceed 256, and the total encoded payload must not
    exceed 65535 bytes (the on-the-wire `attrs_data_size` is a uint16) —
    exceeding that throws.

Records are allocated to fit exactly the encoded payload: an empty
attribute set produces a 28-byte record; richer sets produce
correspondingly larger ones. The OTEP recommends keeping records at or under
640 bytes for compatibility with the OTel eBPF profiler's read buffer, but
the same OTEP excludes Node.js from the eBPF discovery path, so this
package does not enforce that ceiling. Readers that bring their own
size limit will see truncated data past that limit.

**Synchronous callback:**
```javascript
runWithContext(
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
await runWithContext(
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

When passing an async function, `runWithContext` returns a Promise that must be awaited. When passing a synchronous function, it executes immediately and returns the function's result.

### `enterWithContext(opts)`

Attaches the supplied context to the current asynchronous scope without
scoping it to a callback. Wraps `AsyncLocalStorage.enterWith`: the attachment
persists until the current async context naturally ends (e.g. the request
handler that called `enterWithContext` returns). Useful when a callback
boundary is not a natural fit — for instance, when middleware sets context
early in a request handler and wants it to apply to the rest of the handler
chain.

`opts` is the same as for `runWithContext`. Returns nothing.

### `makeNamedContext(keys)`

Returns an object `{ runWithContext, enterWithContext, processContextAttributes }`.
The first two methods accept attributes by name instead of by position. The
`keys` array is the same string list the caller publishes (or has published)
as the `threadlocal.attribute_key_map` resource attribute in the OTEP-4719
process context: index N in `keys` is uint8 key index N on the wire. The
mapping is captured once at factory time.

`opts.namedAttributes` accepts a `Record<string,unknown>`, a `Map`, or an
`Array<[string,unknown]>`. Unknown names throw.

`processContextAttributes` is a frozen, defensively-copied snapshot of the
OTEP-4719 process-context attributes that correspond to this `NamedContext`'s
keys:

```javascript
{
    'threadlocal.schema_version': 'nodejs_v1',
    'threadlocal.attribute_key_map': ['http.method', 'http.route', ...],
}
```

Spread it (or copy its entries) into whatever attribute map the application
hands to its OTEP-4719 process-context publisher. Publishing the same
`keys` you passed to `makeNamedContext` is the easiest way to keep the
writer-side name-to-index mapping in sync with what an external reader
will use to decode the on-the-wire `key_index` bytes back to names.

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
   `attrs_data_size` (uint16), then `attrs_data_size` bytes of attribute
   payload. The total record size is `28 + attrs_data_size`; the writer
   allocates exactly that, so there is no trailing padding.

The process-context schema version corresponding to this writer is
`nodejs_v1` (to be set in `threadlocal.schema_version` of the OTEP-4719
process context, by whichever component the application uses to publish
process context).

### Locating a record from the discovery struct

The pseudo-C++ below illustrates the chain of dereferences a reader walks
to go from the `otel_thread_ctx_nodejs_v1` thread-local to the active
record. It assumes a 64-bit build with V8 pointer compression and the V8
sandbox both off (true for Node's bundled V8 in v22–v26), so `uintptr_t`
is 8 bytes and every tagged pointer below is also 8 bytes. Tagged
pointers have their low bit set; clear it to get the underlying object
address. Smis are 8-byte values whose low 32 bits are zero and whose
high 32 bits hold the integer payload (arithmetic-shift right by 32 to
extract).

```cpp
auto* ctx = read_tls<otel_thread_ctx_nodejs_v1_t>();
if (*ctx->cped_slot == V8_UNDEFINED) return NO_CONTEXT;

// CPED -> current AsyncContextFrame (a JS Map).
auto* acf = untag<JSMap>(*ctx->cped_slot);

// JS Map -> backing OrderedHashMap. The `table` field sits at offset
// 3 * sizeof(uintptr_t) inside the JSMap header.
auto* table = untag<OrderedHashMap>(
    *(tagged_ptr*)((char*)acf + 3 * sizeof(uintptr_t)));

// OrderedHashMap is a FixedArray subclass. Layout after its 2-word
// FixedArray header (map pointer, array-length Smi):
//   [0]  num_elements   (Smi)
//   [1]  num_deleted    (Smi)
//   [2]  num_buckets    (Smi, always a power of two)
//   [3 .. 3+num_buckets)         -- bucket heads (each: Smi entry index, -1 = empty)
//   [3+num_buckets .. )          -- data entries: 3 Smi-or-tagged slots
//                                   per entry: { key, value, next-in-chain }
// Find the entry whose key pointer equals our live ALS object. A fast
// reader uses the published identity hash to pick a single bucket and
// walks just its chain; a simple reader scans every entry.
uintptr_t als = *ctx->als_handle;     // dereference the Global<Object> handle
Entry* e = find_entry(table, als, ctx->als_identity_hash);
if (!e) return NO_CONTEXT;           // ALS not present in this ACF

// Entry value is the JS wrapper for our CtxWrap. Internal field 0 lives
// at offset 3 * sizeof(uintptr_t) inside the JSObject and holds the raw
// native pointer to the C++ wrapper directly (low bits zero because
// the pointer is aligned and Node's V8 has no sandbox).
auto* wrap_js = untag<JSObject>(e->value);
auto* wrap = *(CtxWrap**)((char*)wrap_js + 3 * sizeof(uintptr_t));

// CtxWrap::record_ is the first non-inherited field after the
// node::ObjectWrap base subobject.
auto* record = wrap->record_;
if (record->valid != 1) return NO_CONTEXT;  // mid in-place update; skip
// trace_id, span_id, and attrs_data[0 .. attrs_data_size) are now usable.
```

The structural sketch above matches the actual layouts in every Node.js
release in the v22–v26 range. Two refinements you'll want in a real
implementation:

- **`OrderedHashMap` vs. `SmallOrderedHashMap`.** V8 may use a more
  compact `SmallOrderedHashMap` layout for low-cardinality maps; in
  practice the `AsyncContextFrame` map appears to always be the regular
  `OrderedHashMap` (which is what the pseudo-code assumes), but a
  defensive reader should sniff the layout before parsing.
- **Validation.** Trust nothing until you've checked at least
  `record->valid == 1` — a pointer-chasing walk that lands in the wrong
  place yields garbage at the same offsets. Additional sanity checks
  (`attrs_data_size` is plausible, the bucket count is a power of two,
  Smi-flagged words actually look like Smis) make the reader resilient
  to version drift before the record itself is touched.

## Functionality not currently in scope

* This component does not explicitly coordinate with OTEP-4719 process-context
  for either reading or updating the association of numeric key indices to their
  names.
* We're not merging attribute sets in nested `runWithContext` invocations, a new
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
