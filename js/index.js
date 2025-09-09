let withLabels;
let curLabels;

let hook;

if (process.platform == 'linux') {
    const bindings = require('bindings');

    const addon = bindings('customlabels');

    const { AsyncLocalStorage } = require('node:async_hooks');
    let als = undefined;

    function hasAsyncContextFrame() {
        const [major] = process.versions.node.split('.').map(Number);

        // If explicitly disabled, it's not in use.
        if (process.execArgv.includes('--no-async-context-frame')) return false;

        // Since Node 24, AsyncContextFrame is the default unless disabled.
        if (major >= 24) return true;

        // In Node 22/23, it existed behind an experimental flag.
        if (process.execArgv.includes('--experimental-async-context-frame')) return true;

        // Older versions: not available.
        return false;
    }
    
    function ensureHook() {
        if (als)
            return;
        if (!hasAsyncContextFrame()) {
            throw new Error("This library can only run with async context frame support enabled");
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
