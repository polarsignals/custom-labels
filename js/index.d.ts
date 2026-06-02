/**
 * Inputs to {@link runWithContext} and {@link enterWithContext}.
 *
 * `traceId` and `spanId` are passed as raw bytes (a `Uint8Array` of length 16
 * and 8 respectively; `Buffer` is acceptable as a subclass).
 *
 * `attributes`, if present, is positional: index N in the array is the value
 * for uint8 key index N on the wire. Slots that are `null`, `undefined`, or
 * absent (array holes) are skipped. Non-string values are coerced via
 * `toString`. Values longer than 255 UTF-8 bytes are silently truncated and
 * attributes that would overflow the 612-byte payload budget are silently
 * dropped. Array length must not exceed 256.
 */
export interface ContextOptions {
    traceId: Uint8Array;
    spanId: Uint8Array;
    attributes?: Array<string | null | undefined>;
}

/**
 * Inputs to the methods returned by {@link makeNamedContext}. Same as
 * {@link ContextOptions} but attributes are addressed by name; names are
 * resolved to uint8 key indexes using the array passed to
 * {@link makeNamedContext}.
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
 * Object returned by {@link makeNamedContext}. Each method mirrors the
 * top-level function of the same name, but accepts attributes by name
 * instead of positionally.
 */
export interface NamedContext {
    runWithContext<T>(fn: () => T, opts: NamedContextOptions): T;
    enterWithContext(opts: NamedContextOptions): void;

    /**
     * Append attributes to the currently active thread-context record (the
     * one a prior `runWithContext` or `enterWithContext` attached). Names
     * are resolved to indices via the keys passed to {@link makeNamedContext}.
     *
     * The argument accepts the same shapes as
     * {@link NamedContextOptions.namedAttributes}.
     *
     * Append-only: existing attributes are never modified. If a caller
     * appends at a key that's already present, the OTEP "reader takes the
     * first occurrence" rule means the new value is inert; avoid that.
     *
     * Attributes that would push the record past the 612-byte attrs_data
     * cap are silently dropped, and {@link isContextTruncated} starts
     * returning `true` for the current context.
     *
     * Throws if no context is currently attached.
     */
    appendAttributes(
        namedAttributes:
            | Record<string, unknown>
            | Map<string, unknown>
            | Array<[string, unknown]>,
    ): void;

    /**
     * Returns true if at any point during the current context's lifetime —
     * either at construction (`runWithContext` / `enterWithContext`) or in
     * a subsequent `appendAttributes` call — at least one attribute had
     * to be dropped because it would have pushed the record past the
     * 612-byte attrs_data cap. Always returns false if no context is
     * currently attached.
     */
    isContextTruncated(): boolean;

    /**
     * Snapshot of the OTEP-4719 process-context attributes the caller should
     * publish to keep this context's key map in sync with what readers see.
     * Immutable; safe to spread directly into the caller's attribute map.
     */
    readonly processContextAttributes: ProcessContextAttributes;
}

/**
 * Run `fn` with an OTEP-4947 thread-context record attached to the current
 * asynchronous context. The record propagates through asynchronous
 * continuations and Node.js IO callbacks transparently via
 * `AsyncLocalStorage.run`, and is restored to its prior value when `fn`
 * returns (or its returned promise settles).
 *
 * On non-Linux platforms this is a no-op that simply invokes `fn`.
 */
export function runWithContext<T>(fn: () => T, opts: ContextOptions): T;

/**
 * Attach an OTEP-4947 thread-context record to the current asynchronous
 * context via `AsyncLocalStorage.enterWith`. Unlike {@link runWithContext}
 * there is no scope: the attachment persists until the current async context
 * naturally ends (e.g. the request handler that called `enterWithContext`
 * returns).
 *
 * On non-Linux platforms this is a no-op.
 */
export function enterWithContext(opts: ContextOptions): void;

/**
 * Append attributes to the currently active thread-context record (the one
 * a prior {@link runWithContext} or {@link enterWithContext} attached).
 * Positional, same shape as {@link ContextOptions.attributes}.
 *
 * Append-only: existing attributes are never modified. If a caller appends
 * at a key index that's already present, the OTEP "reader takes the first
 * occurrence" rule means the new value is inert; avoid that.
 *
 * Attributes that would push the record past the 612-byte attrs_data cap
 * are silently dropped, and {@link isContextTruncated} starts returning
 * `true` for the current context.
 *
 * Throws if no context is currently attached.
 *
 * On non-Linux platforms this is a no-op.
 */
export function appendAttributes(
    attributes: Array<string | null | undefined>,
): void;

/**
 * Returns true if at any point during the current context's lifetime —
 * either at construction (via {@link runWithContext} / {@link enterWithContext})
 * or in a subsequent {@link appendAttributes} call — at least one attribute
 * had to be dropped because it would have pushed the record past the
 * 612-byte attrs_data cap.
 *
 * Returns false if no context is currently attached, and on non-Linux
 * platforms.
 */
export function isContextTruncated(): boolean;

/**
 * Build name-addressed wrappers around {@link runWithContext} and
 * {@link enterWithContext}. The supplied `keys` array is the same string
 * list the caller publishes (or has published) as the
 * `threadlocal.attribute_key_map` resource attribute in the OTEP-4719 process
 * context: index N in this array is the uint8 key index N in the on-the-wire
 * record. The mapping is captured once at factory time.
 */
export function makeNamedContext(keys: string[]): NamedContext;
