# OpenTelemetry thread-context writer for Node.js

Node.js library for attaching [OpenTelemetry Thread Local Context Record (OTEP-4947)](
  https://github.com/open-telemetry/opentelemetry-specification/pull/4947)
to asynchronous contexts at runtime. Records are propagated through asynchronous
operations and can be used by external readers (such as the OpenTelemetry eBPF
profiler) to correlate current execution context (e.g. stack traces) with
distributed tracing, user contexts, or any other metadata.

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
const { ThreadContext } = require('@polarsignals/custom-labels');

// Trace and span IDs are raw bytes (Uint8Array of length 16 and 8). Buffer is
// acceptable as a Uint8Array subclass.
const context = new ThreadContext(
    Buffer.from('4bf92f3577b34da6a3ce929d0e0e4736', 'hex'),
    Buffer.from('00f067aa0ba902b7', 'hex'),
    // W3C trace-flags byte; 0x01 is the sampled bit. Pass 0 (or omit) if the
    // sampling decision isn't settled yet and set it later with
    // setTraceFlags().
    0x01,
    // attributes is positional: index N here = uint8 key index N in the wire
    // record. Slots set to null/undefined or array holes are skipped. Key
    // names come from threadlocal.attribute_key_map (OTEP-4719) — for this
    // example, names at indexes 0 and 1 would be e.g. "http.method" and
    // "http.route".
    ['GET', '/api/v1/widgets'],
);

context.run(() => {
    // Code executed here sees `context` as the active thread-context record,
    // including any async work that follows from it. The previous context (if
    // any) is restored when this callback returns.
    performWork();
});
```

Callers typically build a `ThreadContext` once per logical scope (per trace
span, say) and re-install the same JS reference on every async-context entry.
The instance's `enter()` method does that without scoping to a callback;
`getContext` returns whatever's currently attached; the module-level
`clearContext()` detaches it:

```javascript
const { ThreadContext, getContext, clearContext } = require('@polarsignals/custom-labels');

const context = new ThreadContext(traceId, spanId, 0x01, ['GET', '/api/v1/widgets']);
context.enter();
// ... later, in the same async context (or a child) ...
if (getContext() === context) { /* identity check, no byte comparison */ }

// Late discovery of more attributes mutates the record in place, visible to
// every async-context frame that holds this `context` reference:
context.appendAttributes([, , '200']);  // index 2 = http.status, say

clearContext();  // detach when the span ends
```

The same key list the caller writes into `ThreadContext`'s positional
`attributes` argument has to be published alongside the on-the-wire
record so a reader can decode the uint8 key indexes back to names.
`getProcessContextAttributes(keys)` returns a snapshot of the OTEP-4719
attributes (schema version, key map, V8 layout constants) ready to
spread into the application's process-context attribute map:

```javascript
const { getProcessContextAttributes } = require('@polarsignals/custom-labels');
const keys = [
    'http.method', // index 0
    'http.route',  // index 1
];
publishProcessContext({
    ...getProcessContextAttributes(keys),
    // ...the application's own attributes
});
```

## API

### `new ThreadContext(traceId, spanId, traceFlags?, attributes?)`

Construct a thread-context record. Caller manages the lifetime: the underlying
native record is freed when no JS or async-context-frame reference survives.

**Parameters:**
- `traceId` — 16 raw bytes (`Uint8Array`; `Buffer` works as a subclass).
- `spanId` — 8 raw bytes (`Uint8Array`; `Buffer` works as a subclass).
- `traceFlags` (optional) — the W3C trace-flags byte accompanying the ids, an
  integer in 0..255. Defaults to 0, which is what OTEP-4947 prescribes when no
  flags are known; `setTraceFlags()` can change it afterwards. Bits beyond the
  ones W3C currently defines (0x01 sampled, 0x02 random-trace-id) are stored as
  given rather than masked off, because W3C requires unknown flag bits to be
  propagated. Values outside 0..255 and non-integers throw.
- `attributes` (optional) — positional `Array<string | null | undefined>`:
  index N is the value for uint8 key index N on the wire. Slots that are
  `null`, `undefined`, or array holes are skipped. Non-string values are
  coerced via `toString`. Individual values longer than 255 UTF-8 bytes are
  silently truncated to 255 (the on-the-wire length prefix is a uint8). Array
  length must not exceed 256. Entries that would push the encoded payload past
  612 bytes (the OTEP-recommended 640-byte total-record cap minus the 28-byte
  header) are silently dropped — see `isTruncated()` for how to detect that.

Records are right-sized to fit the encoded payload: an empty attribute set
produces a 28-byte record; small sets produce correspondingly small ones,
with a single 64-byte cache-line allocation as the floor. The 612-byte
ceiling matches the read buffer size of typical eBPF-based readers; if you
know your readers are all in-process, you can ignore the `isTruncated`
signal and let the silent drop apply.

Instance methods:

- **`appendAttributes(attributes)`** — append attributes to this record
  (positional, same shape as the constructor's `attributes`). Appending with
  a key index that's already in the record is allowed: OTEP-4947 duplicates
  are last-wins, so the new value overwrites the earlier one for readers
  that decode the record in full. Entries that would push the encoded
  payload past the 612-byte cap are silently dropped (skip-and-continue:
  smaller subsequent entries may still fit), and `isTruncated()` starts
  returning `true`.

  Mutations are visible to every async-context frame that holds the same
  `ThreadContext` reference. Reallocate-on-append re-publishes the record
  pointer on the same JS object — the object itself is never replaced — so
  no per-frame divergence.

- **`invalidate()`** — mark this record's `valid` byte as 0 in place.
  Every async-context frame that still holds this `ThreadContext`
  reference (including those that merely inherited it verbatim from a
  parent frame) will subsequently present the same shared record to a
  reader, so this one call drops the record out of scope for every such
  frame at once. Intended for the span-finish path, where clearing only
  the current frame's context via `clearContext()` would leave
  sibling and detached-continuation frames still exposing the finished
  span. Idempotent.

- **`setTraceFlags(traceFlags)`** — overwrite this record's trace-flags byte
  in place, same value range as the constructor argument. Intended for writers
  whose sampling decision is deferred: build the record with the ids as soon
  as the span starts, leave the flags at 0, and set them once the decision
  happened. A decision that is later overridden can be written again. The write
  reaches every async-context frame holding this `ThreadContext`, because they
  all share one record.

- **`isTruncated()`** — returns `true` if at any point in this record's
  lifetime — either at construction or in a subsequent `appendAttributes`
  call — at least one attribute had to be dropped because it would have
  pushed the record past the 612-byte attrs_data cap. Sticky: once true,
  stays true.

- **`enter()`** — attach this context to the current async-context frame
  via `AsyncLocalStorage.enterWith(this)`. The attachment persists until
  the current async context naturally ends, or until a subsequent
  `enter()` / `run()` on a different context — or a `clearContext()` —
  changes it. Re-installing the same `context` reference is cheap (no
  allocation); the intended usage is to cache one `ThreadContext` per
  logical scope on the caller side and re-install it across every
  async-context fire.

- **`run(callback)`** — scoped variant of `enter()`: runs `callback` with
  this context attached and restores the prior context when the callback
  returns. Wraps `AsyncLocalStorage.run(this, callback)`. When `callback`
  returns a Promise, `run` returns the same Promise that must be awaited;
  for a synchronous callback it executes immediately and returns the
  callback's result.

On non-Linux platforms, `ThreadContext` returns a no-op instance whose
methods do nothing — the OTEP-4947 reader contract is ELF-TLSDESC, only
meaningful on Linux.

### `getContext()`

Returns the `ThreadContext` currently attached to the active async-context
frame, or `undefined` if none is.

### `clearContext()`

Detach any `ThreadContext` from the current async-context frame, via
`AsyncLocalStorage.enterWith(undefined)`. Idempotent when no context is
attached. On non-Linux platforms this is a no-op.

### `getProcessContextAttributes(keys)`

Returns a frozen, defensively-copied snapshot of the OTEP-4719
process-context attributes that go with this writer's on-the-wire
records. The `keys` array is the same string list the caller writes into
`ThreadContext`'s positional `attributes` argument: index N in `keys` is
uint8 key index N on the wire.

`keys` is validated: must be a string array of length ≤ 256 with no
duplicates.

```javascript
{
    'threadlocal.schema_version': 'nodejs_v1_dev',
    'threadlocal.attribute_key_map': ['http.method', 'http.route', ...],
    // V8 layout constants captured from the V8 headers the addon was
    // compiled against. These let the reader walk V8's JSObject and
    // OrderedHashMap layout without having to derive these itself from
    // various build flags.
    // NOTE: the values here are documentation examples and a reader should
    // always read the actual values and not assume the examples here.
    'threadlocal.js_map_table_offset': 24,
    'threadlocal.js_object_record_offset': 24,
    'threadlocal.ordered_hash_map_header_size': 16,
    'threadlocal.tagged_size': 8,
}
```

Spread it (or copy its entries) into whatever attribute map the application
hands to its OTEP-4719 process-context publisher. The `attribute_key_map`
keeps the writer-side index-to-name mapping in sync with what an external
reader will use to decode the on-the-wire `key_index` bytes; the
layout-constant entries are what the reader needs to walk from the V8
async-context frame to the underlying record.

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

     An all-zero value here means the addon has published nothing on this
     thread, or has torn it down again, and none of the other three fields may
     be used. No live isolate has its CPED slot at address zero, and this is
     the pointer the reader dereferences first, so testing it needs no
     assumption about any other field. The addon writes it last when publishing
     and clears it first on teardown, so its zero/nonzero value is always on
     the safe side of the fields it guards.
   - offset `sizeof(void *)`, size `sizeof(void *)` — `als_handle`, a
     `v8::Global<v8::Object>` referring to the `AsyncLocalStorage`
     instance the writer uses. Its underlying representation is a single
     V8 internal pointer.
   - offset `2 * sizeof(void *)`, size `sizeof(int)` — `als_identity_hash`,
     the JS identity hash of that ALS instance. Useful for narrowing the
     search to a single hash bucket inside the `AsyncContextFrame`'s map.
   - offset `3 * sizeof(void *)`, size `sizeof(void *)` —
     `undefined_addr`, the per-isolate tagged address of V8's `undefined`
     singleton. The reader compares the value it retrieves for the ALS
     key against this *before* the internal-field-0 dereference. If equal,
     no context is currently attached (or whatever's there isn't a
     ThreadContext) and the reader skips. Avoids reading garbage when the
     slot happens to hold undefined.


  All four fields are fixed while a particular V8 isolate lives, but they are
  not written only once: the addon populates them when the hook is installed
  and zeroes them again at teardown. A reader must therefore re-read the struct
  on every sample rather than caching field values; one holding a
  pre-teardown copy would go on walking a dead isolate's `cped_slot`, and
  caching `undefined_addr` specifically defeats the liveness check above. What
  is worth caching is the *location* of the thread-local: the module and TLS
  offset.

2. A JavaScript wrapper object (the `ThreadContext` JS class) stored as the
   value for the ALS instance key inside the current `AsyncContextFrame`
   (itself the V8 isolate's `ContinuationPreservedEmbedderData`). Its
   internal field 0 holds a raw pointer to the record itself, so the reader
   reaches the record in a single dereference and needs to know nothing
   about how the writer allocates or tracks it.

3. The record itself is exactly the OTEP-4947 layout: `trace_id[16]`,
   `span_id[8]`, `valid` (always 1, set during construction), `trace_flags`
   (the W3C trace-flags byte; zero when the writer has no flags to report),
   `attrs_data_size` (uint16), then `attrs_data_size` bytes of attribute
   payload. The total record size is `28 + attrs_data_size`; the writer
   allocates exactly that, so there is no trailing padding.

   `trace_flags` may be updated after the record is published — a writer whose
   sampling decision is deferred sets it when the decision was made.

The process-context schema version corresponding to this writer is
`nodejs_v1_dev` (to be set in `threadlocal.schema_version` of the OTEP-4719
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
// Zero cped_slot means nothing is published on this thread (never was, or
// torn down again), so no other field may be used.
if (ctx->cped_slot == 0) return NO_CONTEXT;
if (*ctx->cped_slot == ctx->undefined_addr) return NO_CONTEXT;

// CPED -> current AsyncContextFrame (a JS Map).
auto* acf = untag<JSMap>(*ctx->cped_slot);

// JS Map -> backing OrderedHashMap. The `table` field sits at offset
// `js_map_table_offset` inside the JSMap header.
auto* table = untag<OrderedHashMap>(
    *(tagged_ptr*)((char*)acf + js_map_table_offset));

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
if (e->value == ctx->undefined_addr) return NO_CONTEXT;  // explicit undefined

// Entry value is the JS wrapper for our ThreadContext. Internal field 0
// lives at `js_object_record_offset` inside the JSObject and holds the
// raw native pointer to the record directly (low bits zero because the
// pointer is aligned and Node's V8 has no sandbox).
auto* wrap_js = untag<JSObject>(e->value);
auto* record =
    *(OtelThreadCtxRecord**)((char*)wrap_js + js_object_record_offset);
if (record->valid != 1) return NO_CONTEXT;  // mid in-place update; skip
// trace_id, span_id, and attrs_data[0 .. attrs_data_size) are now usable.
```

The structural sketch above matches the actual layouts in every Node.js
release in the v22–v26 range. For real implementations, there's two additional
aspects worth calling out:

- **`OrderedHashMap` vs. `SmallOrderedHashMap`.** V8 defines a more compact
  `SmallOrderedHashMap` layout as well, but a JS `Map` (which is what an
  `AsyncContextFrame` is) always uses the regular `OrderedHashMap` that the
  pseudo-code assumes. This is a guarantee about V8's current implementation
  rather than a spec invariant, so a defensive reader may still sniff the layout
  to be resilient against future V8 drift.
- **Validation.** Trust nothing until you've checked at least
  `record->valid == 1` — a pointer-chasing walk that lands in the wrong place
  yields garbage at the same offsets. Additional sanity checks
  (`attrs_data_size` is plausible, the bucket count is a power of two,
  Smi-flagged words actually look like Smis) make the reader resilient to
  version drift before the record itself is touched.

## Functionality not currently in scope

* This component does not explicitly coordinate with OTEP-4719 process-context
  for either reading or updating the association of numeric key indices to their
  names.
* There's currently no support for either merging data from multiple records, or
  indeed reading data from a record in-process.

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
