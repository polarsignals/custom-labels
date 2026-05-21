/**
 * A trace_id (16 bytes) or span_id (8 bytes) accepted by this library.
 * Either a Uint8Array of exactly the expected length, or a
 * lowercase/uppercase hex string of exactly twice the expected length.
 */
export type FixedBytes = Uint8Array | string;

/**
 * Inputs to {@link withContext}.
 *
 * Attribute values are coerced to strings; values longer than 255 UTF-8 bytes
 * are silently truncated and attributes that would overflow the 612-byte
 * payload budget are silently dropped, matching the reference Rust
 * implementation.
 */
export interface ContextOptions {
    traceId: FixedBytes;
    spanId: FixedBytes;
    attributes?: Array<[number, string]>;
}

/**
 * Inputs to the function returned by {@link makeNamedContext}. Same as
 * {@link ContextOptions} but attributes are addressed by name; names are
 * resolved to uint8 key indexes using the array passed to
 * {@link makeNamedContext}.
 */
export interface NamedContextOptions {
    traceId: FixedBytes;
    spanId: FixedBytes;
    namedAttributes?:
        | Record<string, unknown>
        | Map<string, unknown>
        | Array<[string, unknown]>;
}

/**
 * Run `fn` with the supplied OpenTelemetry thread context attached. The
 * context propagates through asynchronous continuations and Node.js IO
 * callbacks transparently via AsyncLocalStorage.
 *
 * On non-Linux platforms this is a no-op that simply invokes `fn`.
 */
export function withContext<T>(fn: () => T, opts: ContextOptions): T;

/**
 * Build a name-addressed wrapper around {@link withContext}. The supplied
 * `keys` array is the same string list the caller is expected to publish (or
 * have already published) as the `threadlocal.attribute_key_map` resource
 * attribute in the OTEP-4719 process context: index N in this array is the
 * uint8 key index N in the on-the-wire record.
 *
 * The factory pattern lets callers fix the mapping once at init time and
 * reuse the returned function for every attach.
 */
export function makeNamedContext(
    keys: string[],
): <T>(fn: () => T, opts: NamedContextOptions) => T;
