let withContext;
let makeNamedContext;

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

    withContext = function (fn, opts) {
        if (!opts || typeof opts !== 'object') {
            throw new TypeError('withContext requires an options object');
        }
        ensureHook();
        const wrap = new addon.CtxWrap(
            opts.traceId,
            opts.spanId,
            opts.localRootSpanId,
            opts.attributes,
        );
        return als.run(wrap, fn);
    };

    makeNamedContext = function (keys) {
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

        return function withNamedContext(fn, opts) {
            if (!opts || typeof opts !== 'object') {
                throw new TypeError('withNamedContext requires an options object');
            }

            let attributes;
            const named = opts.namedAttributes;
            if (named != null) {
                attributes = [];
                const push = (name, value) => {
                    const idx = indexByName.get(name);
                    if (idx === undefined) {
                        throw new Error(`unknown attribute name: ${name}`);
                    }
                    attributes.push([idx, String(value)]);
                };
                if (Array.isArray(named)) {
                    for (const [n, v] of named) push(n, v);
                } else if (named instanceof Map) {
                    for (const [n, v] of named) push(n, v);
                } else if (typeof named === 'object') {
                    for (const n of Object.keys(named)) push(n, named[n]);
                } else {
                    throw new TypeError('namedAttributes must be an object, Map, or array of pairs');
                }
            }

            return withContext(fn, {
                traceId: opts.traceId,
                spanId: opts.spanId,
                localRootSpanId: opts.localRootSpanId,
                attributes,
            });
        };
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
    withContext = function (fn, _opts) { return fn(); };
    makeNamedContext = function (_keys) {
        return function withNamedContext(fn, _opts) { return fn(); };
    };
    exports._currentRecordBytes = function () { return undefined; };
}

exports.withContext = withContext;
exports.makeNamedContext = makeNamedContext;
