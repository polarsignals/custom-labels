/**
 * Inputs to {@link NamedContext.buildContext} (and the convenience methods
 * that delegate to it).
 *
 * `traceId` and `spanId` are passed as raw bytes (a `Uint8Array` of length 16
 * and 8 respectively; `Buffer` is acceptable as a subclass).
 *
 * `namedAttributes` are resolved to positional uint8 key indexes via the
 * `keys` array passed to {@link makeNamedContext}. Values are coerced to
 * strings via `toString`. Values longer than 255 UTF-8 bytes are silently
 * truncated, and attributes that would overflow the 612-byte payload cap
 * are silently dropped (see {@link ThreadContext.isTruncated}). Names that
 * aren't in the key map throw.
 */
export interface NamedContextOptions {
    traceId: Uint8Array;
    spanId: Uint8Array;
    namedAttributes?:
        | Record<string, unknown>
        | Map<string, unknown>
        | Array<[string, unknown]>;
}

/**
 * OTEP-4719 process-context attributes corresponding to a particular
 * {@link NamedContext}. Suitable for publishing as part of the application's
 * process context so an out-of-process reader can decode the uint8 key
 * indexes emitted in each thread-context record back to attribute names.
 *
 * The shape matches the OTEP-4947 process-context schema verbatim: an
 * application that publishes its process context as a flat string-keyed
 * attribute map can spread this object into its own attributes.
 */
export interface ProcessContextAttributes {
    readonly 'threadlocal.schema_version': 'nodejs_v1';
    readonly 'threadlocal.attribute_key_map': readonly string[];

    /**
     * Byte offset within a V8 JSObject where internal field 0 lives — the
     * slot the addon sets via `SetAlignedPointerInInternalField` and that
     * the reader dereferences to recover the C++ wrapper pointer. Captured
     * from the V8 headers at addon-compile time so the reader doesn't have
     * to derive it from V8's pointer-compression / sandbox build flags.
     */
    readonly 'threadlocal.nodejs_v1.wrapped_object_offset': number;

    /**
     * V8's tagged-pointer width in bytes (4 with pointer compression, 8
     * without). The reader can use this to derive the JSMap-, FixedArray-,
     * and OrderedHashMap-header offsets it walks without hardcoding them.
     */
    readonly 'threadlocal.nodejs_v1.tagged_size': number;
}

/**
 * A thread-context record. Construct with `new ThreadContext(...)`; install
 * via the {@link enter} or {@link run} instance methods. The underlying
 * native record is GC-owned: when no JS or async-context-frame reference
 * survives, it's freed.
 *
 * `appendAttributes` mutates the record in place. Because every async-context
 * frame that holds the same `ThreadContext` reference observes the same
 * native record buffer, an append is visible across all those frames even
 * when the reallocate path runs (the wrapper's internal pointer is updated,
 * the JS object is not replaced).
 */
export interface ThreadContext {
    /**
     * Append attributes to this record (positional, same shape as the
     * constructor's `attributes` argument). Append-only: existing
     * attributes are never modified.
     *
     * Attributes that would push the record past the 612-byte attrs_data
     * cap are silently dropped, and {@link isTruncated} starts returning
     * `true`.
     */
    appendAttributes(attributes: Array<string | null | undefined> | undefined): void;

    /**
     * True if at any point in this context's lifetime — either at
     * construction or in a subsequent {@link appendAttributes} call — at
     * least one attribute had to be dropped because it would have pushed
     * the record past the 612-byte attrs_data cap.
     */
    isTruncated(): boolean;

    /** Debug-only: returns the on-the-wire record bytes. Not stable. */
    debugBytes(): Uint8Array;

    /**
     * Attach this context to the current async-context frame (and every
     * frame derived from it until the frame ends or {@link clearContext}
     * detaches it). Re-installing the same context reference is cheap (no
     * allocation); per-span caching of the context on the caller side is
     * the intended usage pattern.
     *
     * On non-Linux platforms this is a no-op.
     */
    enter(): void;

    /**
     * Attach this context for the duration of `fn`. Equivalent to
     * `als.run(this, fn)` — after `fn` returns, the previous context is
     * restored. Returns whatever `fn` returns; if `fn` returns a Promise,
     * the same Promise is propagated. On non-Linux platforms simply
     * invokes `fn`.
     */
    run<T>(fn: () => T): T;
}

/**
 * Constructor for {@link ThreadContext}. `attributes`, if present, is
 * positional: index N is the value for uint8 key index N on the wire.
 * Slots that are `null`, `undefined`, or absent (array holes) are skipped.
 * Non-string values are coerced via `toString`. Array length must not
 * exceed 256.
 *
 * On non-Linux platforms, returns a no-op instance whose methods do
 * nothing — the OTEP-4947 reader contract is ELF-TLSDESC, only meaningful
 * on Linux.
 */
export interface ThreadContextCtor {
    new (
        traceId: Uint8Array,
        spanId: Uint8Array,
        attributes?: Array<string | null | undefined>,
    ): ThreadContext;
}

/**
 * Object returned by {@link makeNamedContext}. Resolves the
 * `namedAttributes` map to a positional array against the key list
 * captured at factory time and builds a {@link ThreadContext};
 * convenience methods compose with {@link ThreadContext.enter} /
 * {@link ThreadContext.run}.
 */
export interface NamedContext {
    /** Allocate a ThreadContext with attributes resolved positionally by name. */
    buildContext(opts: NamedContextOptions): ThreadContext;
    /** Sugar: `buildContext(opts).enter()`. */
    enterWithContext(opts: NamedContextOptions): void;
    /** Sugar: `buildContext(opts).run(fn)`. */
    runWithContext<T>(fn: () => T, opts: NamedContextOptions): T;
    /** Sugar: re-export of the module-level {@link clearContext}. */
    clearContext(): void;
    /**
     * Snapshot of the OTEP-4719 process-context attributes the caller should
     * publish to keep this context's key map in sync with what readers see.
     * Immutable; safe to spread directly into the caller's attribute map.
     */
    readonly processContextAttributes: ProcessContextAttributes;
}

/**
 * Construct a thread-context record. Caller manages the lifetime. On
 * non-Linux platforms, returns a no-op instance.
 */
export const ThreadContext: ThreadContextCtor;

/**
 * Returns the {@link ThreadContext} currently attached to the active
 * async-context frame, or `undefined` if none is.
 */
export function getContext(): ThreadContext | undefined;

/**
 * Detach any {@link ThreadContext} from the current async-context frame.
 * Idempotent when no context is attached. On non-Linux platforms this is
 * a no-op.
 */
export function clearContext(): void;

/**
 * Build a name-addressed factory for {@link ThreadContext}. The supplied
 * `keys` array is the same string list the caller publishes (or has
 * published) as the `threadlocal.attribute_key_map` resource attribute in
 * the OTEP-4719 process context: index N in this array is the uint8 key
 * index N in the on-the-wire record. The mapping is captured once at
 * factory time.
 */
export function makeNamedContext(keys: string[]): NamedContext;
