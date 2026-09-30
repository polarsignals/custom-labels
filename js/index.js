'use strict';

const SCHEMA_VERSION = 'nodejs_v1_dev';

// Public surface, populated by the Linux branch below. On other
// platforms these stay as no-op stubs / a sham class.
let ThreadContext;
let getContext;
let clearContext;
let isAsyncContextFrameActive;

if (process.platform === 'linux') {
    const bindings = require('bindings');
    const addon = bindings('customlabels');

    ThreadContext = addon.ThreadContext;

    const { AsyncLocalStorage } = require('node:async_hooks');
    let als;

    let acfActive;

    // Whether this process's AsyncLocalStorage is backed by AsyncContextFrame,
    // which is what puts the active value in the isolate's
    // ContinuationPreservedEmbedderData slot that an out-of-process reader
    // walks.
    //
    // Feature-detected rather than inferred from the Node version plus
    // `process.execArgv`, because the two can disagree (and `execArgv` is not
    // reliable anyway; it can be rewritten by tooling or not passed on to a
    // worker thread).
    //
    // Detected by asking the addon what is in the CPED slot during a `run()`.
    // With ACF, Node installs an AsyncContextFrame — a JS Map keyed by the
    // AsyncLocalStorage instance, valued by its store — as the running
    // continuation's CPED; without it, nothing writes the slot. So a probe
    // storage whose own store is visible there is direct evidence.
    //
    // Memoized: the answer is fixed for the life of the thread.
    isAsyncContextFrameActive = function () {
        if (acfActive === undefined) {
            const probe = new AsyncLocalStorage();
            // Object so we strict-equal compare based on identity
            const sentinel = {};
            let bound = false;
            probe.run(sentinel, () => {
                bound = addon.cpedMapContains(probe, sentinel);
            });
            probe.disable();
            acfActive = bound;
        }
        return acfActive;
    };

    // How to turn AsyncContextFrame on, for the error message below. Advisory
    // text only — never decide availability from this; that is what
    // isAsyncContextFrameActive is for.
    function asyncContextFrameHint() {
        const version = process.versions.node;
        const [major, minor] = version.split('.').map(Number);
        if (major < 22 || (major === 22 && minor < 7)) {
            return `Node ${version} does not support it at all; Node 24 and later enable it by default`;
        }
        if (major < 24) {
            return `Node ${version} needs --experimental-async-context-frame, on the command line or in NODE_OPTIONS; Node 24 and later enable it by default`;
        }
        return `Node ${version} enables it by default, so something turned it off — look for --no-async-context-frame on the command line, in NODE_OPTIONS, or in this worker's execArgv`;
    }

    function ensureHook() {
        if (als) return;
        if (!isAsyncContextFrameActive()) {
            throw new Error(`otel thread-ctx writer requires async_context_frame support, which is unavailable: ${asyncContextFrameHint()}.`);
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
        invalidate() {}
        setTraceFlags() {}
        isTruncated() { return false; }
        debugBytes() { return new Uint8Array(0); }
        enter() {}
        run(fn) { return fn(); }
    }
    ThreadContext = NoopThreadContext;
    getContext = function () { return undefined; };
    // No addon to probe with, and nothing to publish to a reader anyway.
    isAsyncContextFrameActive = function () { return false; };
    clearContext = function () {};
    exports._currentRecordBytes = function () { return undefined; };
}

/**
 * Snapshot of the OTEP-4719 process-context attributes the caller should
 * publish so an out-of-process reader can (a) decode the on-the-wire
 * uint8 key indexes back to names and (b) walk V8's wrapper / hashmap
 * layout without doing its own V8-internal symbol lookups. The `keys`
 * argument is the same string list the caller writes into ThreadContext's
 * positional attributes array: index N in this array is the uint8 key
 * index N in the on-the-wire record.
 *
 * The returned object is frozen and defensively copied; safe to spread
 * into the caller's process-context attribute map.
 */
function getProcessContextAttributes(keys) {
    if (!Array.isArray(keys)) {
        throw new TypeError('keys must be an array of attribute names');
    }
    if (keys.length > 256) {
        throw new RangeError('keys array exceeds 256 entries');
    }
    const seen = new Set();
    for (let i = 0; i < keys.length; ++i) {
        const name = keys[i];
        if (typeof name !== 'string') {
            throw new TypeError('every key must be a string');
        }
        if (seen.has(name)) {
            throw new Error(`duplicate key name at index ${i}: ${name}`);
        }
        seen.add(name);
    }
    return Object.freeze({
        'threadlocal.schema_version': SCHEMA_VERSION,
        'threadlocal.attribute_key_map': Object.freeze(keys.slice()),
    });
}

exports.ThreadContext = ThreadContext;
exports.getContext = getContext;
exports.clearContext = clearContext;
exports.getProcessContextAttributes = getProcessContextAttributes;
// Not part of the stable API; for tests and for callers that would rather
// check up front than catch the error enter() / run() throw without ACF.
exports._isAsyncContextFrameActive = isAsyncContextFrameActive;
