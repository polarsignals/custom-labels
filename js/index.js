let runWithContext;
let enterWithContext;
let appendAttributes;
let isContextTruncated;

const SCHEMA_VERSION = 'nodejs_v1';

if (process.platform === 'linux') {
    const bindings = require('bindings');

    const addon = bindings('customlabels');

    const { AsyncLocalStorage } = require('node:async_hooks');
    let als = undefined;

    function asyncContextFrameError() {
        const [major] = process.versions.node.split('.').map(Number);

        // If explicitly disabled, it's not in use.
        if (process.execArgv.includes('--no-async-context-frame')) return "Node explicitly launched with --no-async-context-frame";

        // Since Node 24, AsyncContextFrame is the default unless disabled.
        if (major >= 24) return undefined;

        // In Node 22/23, it existed behind an experimental flag.
        if (process.execArgv.includes('--experimental-async-context-frame')) return undefined;
        if (major >= 22) return "Node versions prior to v24 must be launched with --experimental-async-context-frame";

        // Older versions: not available.
        return "Node major versions prior to v22 do not support the feature at all";
    }

    function ensureHook() {
        if (als)
            return;
        const err = asyncContextFrameError();
        if (err) {
            throw new Error(`otel thread-ctx writer requires async_context_frame support, which is unavailable: ${err}.`);
        }
        als = new AsyncLocalStorage();
        addon.storeAls(als);
    }

    function buildWrap(opts) {
        if (!opts || typeof opts !== 'object') {
            throw new TypeError('options object required');
        }
        ensureHook();
        return new addon.CtxWrap(
            opts.traceId,
            opts.spanId,
            opts.attributes,
        );
    }

    runWithContext = function (fn, opts) {
        const wrap = buildWrap(opts);
        return als.run(wrap, fn);
    };

    enterWithContext = function (opts) {
        const wrap = buildWrap(opts);
        als.enterWith(wrap);
    };

    appendAttributes = function (attributes) {
        if (!als) {
            throw new Error('no active thread context; call runWithContext or enterWithContext first');
        }
        const wrap = als.getStore();
        if (!wrap) {
            throw new Error('no active thread context; call runWithContext or enterWithContext first');
        }
        wrap.append(attributes);
    };

    isContextTruncated = function () {
        if (!als) return false;
        const wrap = als.getStore();
        if (!wrap) return false;
        return wrap.isTruncated();
    };

    // Debug accessor (not part of the stable API; for tests / reader dev):
    // returns a Uint8Array view of the currently attached record, or undefined.
    exports._currentRecordBytes = function () {
        if (!als) return undefined;
        const wrap = als.getStore();
        if (!wrap) return undefined;
        return wrap.bytes();
    };
} else {
    runWithContext = function (fn, _opts) { return fn(); };
    enterWithContext = function (_opts) {};
    appendAttributes = function (_attributes) {};
    isContextTruncated = function () { return false; };
    exports._currentRecordBytes = function () { return undefined; };
}

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
        if (named == null) return undefined;
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

    function toBaseOpts(opts) {
        if (!opts || typeof opts !== 'object') {
            throw new TypeError('options object required');
        }
        return {
            traceId: opts.traceId,
            spanId: opts.spanId,
            attributes: resolveAttributes(opts.namedAttributes),
        };
    }

    // Snapshot of the OTEP-4719 process-context attributes the caller should
    // publish to keep the names this NamedContext resolves against in sync
    // with what an out-of-process reader sees. Frozen + defensively copied
    // so the caller can't mutate it back into our internal state.
    const processContextAttributes = Object.freeze({
        'threadlocal.schema_version': SCHEMA_VERSION,
        'threadlocal.attribute_key_map': Object.freeze(keys.slice()),
    });

    return {
        runWithContext(fn, opts) {
            return runWithContext(fn, toBaseOpts(opts));
        },
        enterWithContext(opts) {
            enterWithContext(toBaseOpts(opts));
        },
        appendAttributes(namedAttributes) {
            appendAttributes(resolveAttributes(namedAttributes));
        },
        isContextTruncated() {
            return isContextTruncated();
        },
        processContextAttributes,
    };
}

exports.runWithContext = runWithContext;
exports.enterWithContext = enterWithContext;
exports.appendAttributes = appendAttributes;
exports.isContextTruncated = isContextTruncated;
exports.makeNamedContext = makeNamedContext;
