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
}

/**
 * Object returned by {@link makeNamedContext}. Each method mirrors the
 * top-level function of the same name, but accepts {@link NamedContextOptions}
 * (i.e. attributes by name) instead of positional.
 */
export interface NamedContext {
    runWithContext<T>(fn: () => T, opts: NamedContextOptions): T;
    enterWithContext(opts: NamedContextOptions): void;

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
 * Build name-addressed wrappers around {@link runWithContext} and
 * {@link enterWithContext}. The supplied `keys` array is the same string
 * list the caller publishes (or has published) as the
 * `threadlocal.attribute_key_map` resource attribute in the OTEP-4719 process
 * context: index N in this array is the uint8 key index N in the on-the-wire
 * record. The mapping is captured once at factory time.
 */
export function makeNamedContext(keys: string[]): NamedContext;
