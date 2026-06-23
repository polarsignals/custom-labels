'use strict';

const SCHEMA_VERSION = 'nodejs_v1_dev';

// V8 layout constants the addon captured from the V8 headers Node bundles.
// On non-Linux these fall back to the values matching Node's standard
// build (no V8 pointer compression, no sandbox) — the reader is Linux-only
// per the OTEP anyway, so non-Linux callers republishing process context
// see consistent values.
let WRAPPED_OBJECT_OFFSET = 24;
let TAGGED_SIZE = 8;

// Public surface, populated by the Linux branch below. On other
// platforms these stay as no-op stubs / a sham class.
let ThreadContext;
let getContext;
let clearContext;

if (process.platform === 'linux') {
    const bindings = require('bindings');
    const addon = bindings('customlabels');
    WRAPPED_OBJECT_OFFSET = addon.wrappedObjectOffset;
    TAGGED_SIZE = addon.taggedSize;

    ThreadContext = addon.ThreadContext;

    const { AsyncLocalStorage } = require('node:async_hooks');
    let als;

    function asyncContextFrameError() {
        const [major] = process.versions.node.split('.').map(Number);
        // Explicit opt-out: it's not in use.
        if (process.execArgv.includes('--no-async-context-frame')) return 'Node explicitly launched with --no-async-context-frame';
        // Since Node 24, AsyncContextFrame is the default unless disabled.
        if (major >= 24) return undefined;
        // In Node 22/23, it existed behind an experimental flag.
        if (process.execArgv.includes('--experimental-async-context-frame')) return undefined;
        if (major >= 22) return 'Node versions prior to v24 must be launched with --experimental-async-context-frame';
        // Older versions: not available.
        return 'Node major versions prior to v22 do not support the feature at all';
    }

    function ensureHook() {
        if (als) return;
        const err = asyncContextFrameError();
        if (err) {
            throw new Error(`otel thread-ctx writer requires async_context_frame support, which is unavailable: ${err}.`);
        }
        als = new AsyncLocalStorage();
        addon.storeAls(als);
    }

    getContext = function () {
        return als ? als.getStore() : undefined;
    };

    // Idempotent: clearing when the hook hasn't been installed (no prior
    // enter / run on a ThreadContext) is a no-op.
    clearContext = function () {
        if (!als) return;
        als.enterWith(undefined);
    };

    // Install the active-context channel on the ThreadContext prototype so
    // the only way to push a ThreadContext into our AsyncLocalStorage is
    // via the context itself — callers can't poison the ALS with an
    // arbitrary object.
    ThreadContext.prototype.enter = function () {
        ensureHook();
        als.enterWith(this);
    };
    ThreadContext.prototype.run = function (fn) {
        ensureHook();
        return als.run(this, fn);
    };

    // Debug accessor (not part of the stable API; for tests / reader dev):
    // returns a Uint8Array view of the currently attached record, or undefined.
    exports._currentRecordBytes = function () {
        const c = getContext();
        return c ? c.debugBytes() : undefined;
    };
} else {
    // Non-Linux degradation. The writer's reader contract is ELF-TLSDESC,
    // meaningful only on Linux; on other platforms we still want the API
    // to be callable so consumers don't have to gate every call site —
    // construction succeeds but produces an inert context, and the
    // enter/run/clearContext entry points don't wire anything into
    // AsyncLocalStorage.
    class NoopThreadContext {
        appendAttributes() {}
        isTruncated() { return false; }
        debugBytes() { return new Uint8Array(0); }
        enter() {}
        run(fn) { return fn(); }
    }
    ThreadContext = NoopThreadContext;
    getContext = function () { return undefined; };
    clearContext = function () {};
    exports._currentRecordBytes = function () { return undefined; };
}

/**
 * Build a name-addressed factory for ThreadContext. The supplied `keys`
 * array is the same string list the caller publishes (or has published)
 * as the `threadlocal.attribute_key_map` resource attribute in the
 * OTEP-4719 process context: index N in this array is the uint8 key
 * index N in the on-the-wire record. The mapping is captured once at
 * factory time.
 */
function makeNamedContext(keys) {
    if (!Array.isArray(keys)) {
        throw new TypeError('keys must be an array of attribute names');
    }
    if (keys.length > 256) {
        throw new RangeError('keys array exceeds 256 entries');
    }
    const indexByName = new Map();
    keys.forEach((name, i) => {
        if (typeof name !== 'string') {
            throw new TypeError('every key must be a string');
        }
        if (indexByName.has(name)) {
            throw new Error(`duplicate key name at indexes ${indexByName.get(name)} and ${i}: ${name}`);
        }
        indexByName.set(name, i);
    });

    function resolveAttributes(named) {
        if (named === null || named === undefined) return undefined;
        const attributes = [];
        const set = (name, value) => {
            const idx = indexByName.get(name);
            if (idx === undefined) {
                throw new Error(`unknown attribute name: ${name}`);
            }
            attributes[idx] = String(value);
        };
        if (Array.isArray(named)) {
            for (const [n, v] of named) set(n, v);
        } else if (named instanceof Map) {
            for (const [n, v] of named) set(n, v);
        } else if (typeof named === 'object') {
            for (const n of Object.keys(named)) set(n, named[n]);
        } else {
            throw new TypeError('namedAttributes must be an object, Map, or array of pairs');
        }
        return attributes;
    }

    function buildContext(opts) {
        if (!opts || typeof opts !== 'object') {
            throw new TypeError('options object required');
        }
        return new ThreadContext(opts.traceId, opts.spanId, resolveAttributes(opts.namedAttributes));
    }

    // Snapshot of the OTEP-4719 process-context attributes the caller should
    // publish so an out-of-process reader can (a) decode key indices back to
    // names and (b) walk V8's wrapper/hashmap layout without doing its own
    // V8-internal symbol lookups. Frozen + defensively copied so the caller
    // can't mutate it back into our internal state.
    const processContextAttributes = Object.freeze({
        'threadlocal.schema_version': SCHEMA_VERSION,
        'threadlocal.attribute_key_map': Object.freeze(keys.slice()),
        'threadlocal.wrapped_object_offset': WRAPPED_OBJECT_OFFSET,
        'threadlocal.tagged_size': TAGGED_SIZE,
    });

    return {
        buildContext,
        // Sugar: build a context from `opts`, then enter / run / clear via
        // the ThreadContext methods.
        enterWithContext(opts) {
            buildContext(opts).enter();
        },
        runWithContext(fn, opts) {
            return buildContext(opts).run(fn);
        },
        clearContext() {
            clearContext();
        },
        processContextAttributes,
    };
}

exports.ThreadContext = ThreadContext;
exports.getContext = getContext;
exports.clearContext = clearContext;
exports.makeNamedContext = makeNamedContext;
