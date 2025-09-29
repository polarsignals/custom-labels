let withLabels;
let curLabels;

let hook;

if (process.platform == 'linux') {
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
            throw new Error(`Custom labels requires async_context_frame support, which is unavailable: ${err}.`);
        }
        als = new AsyncLocalStorage();
        addon.storeHash(als);
    }

    curLabels = function() {
        ensureHook();

        return als.getStore();
    };
    
    withLabels = function(f, ...kvs) {
        ensureHook();
        const curs = curLabels();
        const newLabels = new addon.ClWrap(curs, ...kvs);
        return als.run(newLabels, f);
    };
} else {
    withLabels = function(f, ...kvs) {
        return f();
    };

    curLabels = function() { return undefined; };
}

exports.withLabels = withLabels;
exports.curLabels = curLabels;
